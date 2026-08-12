import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/preflight.js', () => ({
  runPreflight: vi.fn(),
  formatPreflightReport: vi.fn(() => 'yt-dlp: 2026.07.04\nffmpeg: not installed'),
}));
vi.mock('../../src/utils/ytdlp.js', () => ({ concurrencyState: vi.fn() }));

import { runPreflight } from '../../src/utils/preflight.js';
import { concurrencyState } from '../../src/utils/ytdlp.js';
import { checkHealthHandler } from '../../src/tools/check-health.js';

const REPORT = {
  ok: true,
  ytDlp: { name: 'yt-dlp', installed: true, version: '2026.07.04' },
  ffmpeg: { name: 'ffmpeg', installed: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runPreflight).mockResolvedValue(REPORT);
  vi.mocked(concurrencyState).mockReturnValue({ active: 1, queued: 2, limit: 4 });
});

describe('checkHealthHandler', () => {
  it('reports on both binaries', async () => {
    const result = await checkHealthHandler();

    expect(structuredOf(result)).toMatchObject({
      ok: true,
      ytDlp: { installed: true, version: '2026.07.04' },
      ffmpeg: { installed: false },
    });
  });

  it('reports the yt-dlp queue, which explains a slow-looking server', async () => {
    const result = await checkHealthHandler();

    expect(textOf(result)).toContain('yt-dlp concurrency: 1/4 active, 2 queued');
    expect(structuredOf(result)).toMatchObject({
      concurrency: { active: 1, queued: 2, limit: 4 },
    });
  });

  it('re-runs the check rather than reading a cached verdict', async () => {
    // The tool exists to answer "is it working now", so a cached answer from
    // startup would defeat the point.
    await checkHealthHandler();

    expect(runPreflight).toHaveBeenCalledWith({ force: true });
  });

  it('passes on a failing verdict', async () => {
    vi.mocked(runPreflight).mockResolvedValue({ ...REPORT, ok: false });

    expect(structuredOf(await checkHealthHandler())).toMatchObject({ ok: false });
  });
});
