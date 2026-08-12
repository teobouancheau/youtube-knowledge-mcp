import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn(), ExecaError: class extends Error {} }));

import { execa } from 'execa';
import {
  formatPreflightReport,
  parseYtDlpAgeDays,
  requireFfmpeg,
  resetPreflightCache,
  runPreflight,
} from '../../src/utils/preflight.js';
import { YouTubeError } from '../../src/utils/errors.js';

const mockedExeca = vi.mocked(execa);

/** yt-dlp answers `--version`; ffmpeg answers `-version`. */
function respond(versions: { ytDlp?: string; ffmpeg?: string }): void {
  mockedExeca.mockImplementation(((command: string) => {
    if (command === 'yt-dlp') {
      return versions.ytDlp === undefined
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve({ stdout: versions.ytDlp });
    }
    return versions.ffmpeg === undefined
      ? Promise.reject(new Error('ENOENT'))
      : Promise.resolve({ stdout: `ffmpeg version ${versions.ffmpeg} Copyright (c) 2000-2024` });
  }) as never);
}

describe('parseYtDlpAgeDays', () => {
  const now = Date.UTC(2026, 0, 31);

  it('measures the age of a date-stamped version', () => {
    expect(parseYtDlpAgeDays('2026.01.01', now)).toBe(30);
  });

  it('handles same-day releases', () => {
    expect(parseYtDlpAgeDays('2026.01.31', now)).toBe(0);
  });

  it('tolerates the suffix on nightly builds', () => {
    expect(parseYtDlpAgeDays('2026.01.01.232349', now)).toBe(30);
  });

  it('returns undefined for a version it cannot date', () => {
    expect(parseYtDlpAgeDays('unknown', now)).toBeUndefined();
  });
});

describe('runPreflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPreflightCache();
  });

  it('reports both binaries when present', async () => {
    respond({ ytDlp: '2026.08.01', ffmpeg: '6.1.1' });

    const report = await runPreflight();

    expect(report.ok).toBe(true);
    expect(report.ytDlp).toMatchObject({ installed: true, version: '2026.08.01' });
    expect(report.ffmpeg).toMatchObject({ installed: true, version: '6.1.1' });
  });

  it('keeps a successful report without re-probing', async () => {
    respond({ ytDlp: '2026.08.01', ffmpeg: '6.1.1' });

    await runPreflight();
    await runPreflight();

    // Two binaries, probed once between them.
    expect(mockedExeca).toHaveBeenCalledTimes(2);
  });

  it('re-probes after a failure rather than pinning /health to 503 for good', async () => {
    // A probe spawns a binary with a timeout, and a loaded host can miss it
    // once. Caching that answer for the process lifetime meant a deployment
    // that lost a single probe at boot never reported healthy again.
    vi.useFakeTimers();
    try {
      respond({ ffmpeg: '6.1.1' });
      expect((await runPreflight()).ok).toBe(false);

      vi.advanceTimersByTime(59_000);
      respond({ ytDlp: '2026.08.01', ffmpeg: '6.1.1' });
      expect((await runPreflight()).ok, 'still within the failed report TTL').toBe(false);

      vi.advanceTimersByTime(2_000);
      expect((await runPreflight()).ok, 'past the TTL, so probed again').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not ok without yt-dlp, since every tool needs it', async () => {
    respond({ ffmpeg: '6.1.1' });

    const report = await runPreflight();

    expect(report.ok).toBe(false);
    expect(report.ytDlp.installed).toBe(false);
  });

  it('stays ok without ffmpeg, since most tools do not need it', async () => {
    respond({ ytDlp: '2026.08.01' });

    const report = await runPreflight();

    expect(report.ok).toBe(true);
    expect(report.ffmpeg.installed).toBe(false);
  });

  it('warns when yt-dlp is old enough to start failing against YouTube', async () => {
    respond({ ytDlp: '2020.01.01', ffmpeg: '6.1.1' });

    const report = await runPreflight();

    expect(report.ytDlp.warning).toContain('yt-dlp -U');
  });

  it('caches the result and re-probes only when forced', async () => {
    respond({ ytDlp: '2026.08.01', ffmpeg: '6.1.1' });

    await runPreflight();
    await runPreflight();
    expect(mockedExeca).toHaveBeenCalledTimes(2); // one per binary, once

    await runPreflight({ force: true });
    expect(mockedExeca).toHaveBeenCalledTimes(4);
  });
});

describe('requireFfmpeg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPreflightCache();
  });

  it('passes when ffmpeg is installed', async () => {
    respond({ ytDlp: '2026.08.01', ffmpeg: '6.1.1' });
    await expect(requireFfmpeg('Clip extraction')).resolves.toBeUndefined();
  });

  it('fails with install instructions when it is not', async () => {
    respond({ ytDlp: '2026.08.01' });

    const error = (await requireFfmpeg('Clip extraction').catch((e: unknown) => e)) as YouTubeError;

    expect(error).toBeInstanceOf(YouTubeError);
    expect(error.code).toBe('FFMPEG_MISSING');
    expect(error.message).toContain('Clip extraction');
    expect(error.toToolMessage()).toContain('brew install ffmpeg');
  });
});

describe('formatPreflightReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPreflightCache();
  });

  it('tells the operator how to install a missing yt-dlp', async () => {
    respond({});
    const text = formatPreflightReport(await runPreflight());

    expect(text).toContain('✗ Not ready');
    expect(text).toContain('pip install -U yt-dlp');
  });

  it('explains precisely what is lost without ffmpeg', async () => {
    respond({ ytDlp: '2026.08.01' });
    const text = formatPreflightReport(await runPreflight());

    expect(text).toContain('✓ Ready');
    expect(text).toContain('ffmpeg: not installed');
    expect(text).toContain('clip extraction');
  });

  it('surfaces the staleness warning', async () => {
    respond({ ytDlp: '2020.01.01', ffmpeg: '6.1.1' });
    expect(formatPreflightReport(await runPreflight())).toContain('yt-dlp -U');
  });
});
