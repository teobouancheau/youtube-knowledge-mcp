import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/preflight.js', () => ({
  runPreflight: vi.fn(),
  formatPreflightReport: vi.fn(() => 'yt-dlp: 2026.07.04\nffmpeg: not installed'),
}));
vi.mock('../../src/utils/ytdlp.js', () => ({ concurrencyState: vi.fn() }));
vi.mock('../../src/utils/pot-preflight.js', () => ({ runSessionPreflight: vi.fn() }));
vi.mock('../../src/utils/store-health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/store-health.js')>();
  return { ...actual, readStoreHealth: vi.fn() };
});
vi.mock('../../src/utils/ytdlp-env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/ytdlp-env.js')>();
  return { ...actual, readYtDlpEnv: vi.fn(() => ({ args: [], cookies: 'none', proxy: false })) };
});

import { runPreflight } from '../../src/utils/preflight.js';
import { concurrencyState } from '../../src/utils/ytdlp.js';
import { runSessionPreflight } from '../../src/utils/pot-preflight.js';
import { readStoreHealth } from '../../src/utils/store-health.js';
import { readYtDlpEnv } from '../../src/utils/ytdlp-env.js';
import { checkHealthHandler } from '../../src/tools/check-health.js';

const REPORT = {
  ok: true,
  ytDlp: { name: 'yt-dlp', installed: true, version: '2026.07.04' },
  ffmpeg: { name: 'ffmpeg', installed: false },
};

const EMPTY_STORE = {
  enabled: true,
  path: '/tmp/knowledge.db',
  exists: false,
  sizeBytes: 0,
  walBytes: 0,
  integrity: 'ok' as const,
  channels: 0,
  videos: 0,
  comments: 0,
  receipts: { complete: 0, partial: 0, running: 0, failed: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runPreflight).mockResolvedValue(REPORT);
  vi.mocked(concurrencyState).mockReturnValue({ active: 1, queued: 2, limit: 4 });
  vi.mocked(runSessionPreflight).mockResolvedValue({
    potAvailable: false,
    potProviders: [],
    jsRuntimes: [],
    impersonateTargets: [],
  });
  vi.mocked(readStoreHealth).mockResolvedValue(EMPTY_STORE);
});

describe('checkHealthHandler store', () => {
  it('does not fail ok for a store that does not exist yet', async () => {
    const result = await checkHealthHandler();

    expect(textOf(result)).toContain('Store: empty');
    expect(structuredOf(result)).toMatchObject({ ok: true, store: { exists: false } });
  });

  it('reports what the store holds', async () => {
    vi.mocked(readStoreHealth).mockResolvedValue({
      ...EMPTY_STORE,
      exists: true,
      sizeBytes: 4096,
      storeVersion: 1,
      videos: 12,
      comments: 3400,
    });

    const result = await checkHealthHandler();
    expect(textOf(result)).toContain('Store: 12 videos, 3400 comments, integrity ok');
    expect(structuredOf(result)).toMatchObject({ ok: true, store: { videos: 12, comments: 3400 } });
  });

  it('fails ok when the store fails its integrity check', async () => {
    vi.mocked(readStoreHealth).mockResolvedValue({
      ...EMPTY_STORE,
      exists: true,
      integrity: 'failed',
    });

    expect(structuredOf(await checkHealthHandler())).toMatchObject({ ok: false });
  });

  it('surfaces a store that could not be opened without failing the binaries report', async () => {
    vi.mocked(readStoreHealth).mockResolvedValue({
      ...EMPTY_STORE,
      enabled: false,
      error: 'This Node build has no node:sqlite',
    });

    expect(structuredOf(await checkHealthHandler())).toMatchObject({
      ok: true,
      store: { enabled: false, error: 'This Node build has no node:sqlite' },
    });
  });
});

describe('checkHealthHandler session capabilities', () => {
  it('says "none" when yt-dlp reports no usable PO token provider', async () => {
    const result = await checkHealthHandler();

    expect(textOf(result)).toContain('PO token providers: none');
    expect(textOf(result)).toContain('install curl_cffi');
    expect(structuredOf(result)).toMatchObject({ session: { potProviders: [] } });
  });

  it('lists only usable providers and runtimes, never the unavailable ones', async () => {
    vi.mocked(runSessionPreflight).mockResolvedValue({
      potAvailable: true,
      potProviders: [
        { name: 'bgutil:http-1.3.2', available: true, flags: ['external'] },
        { name: 'bgutil:script-node', available: false, flags: ['external', 'unavailable'] },
      ],
      jsRuntimes: [
        { name: 'deno', available: true, flags: [] },
        { name: 'node', available: false, flags: ['unavailable'] },
      ],
      impersonateTargets: ['Chrome-133:Macos-15', 'Safari-18.4:Ios-18.4'],
    });

    const result = await checkHealthHandler();

    expect(textOf(result)).toContain('PO token providers: bgutil:http-1.3.2');
    expect(textOf(result)).toContain('Impersonate targets: 2 available');
    expect(structuredOf(result)).toMatchObject({
      session: {
        potProviders: ['bgutil:http-1.3.2'],
        jsRuntimes: ['deno'],
        impersonateTargets: ['Chrome-133:Macos-15', 'Safari-18.4:Ios-18.4'],
      },
    });
  });

  it('does not fail ok when a provider is missing', async () => {
    // A missing PO token provider does not predict a blocked player plane —
    // measured 2026-09-06 — and a health check that cries wolf gets ignored.
    expect(structuredOf(await checkHealthHandler())).toMatchObject({ ok: true });
  });

  it('surfaces a failed probe rather than reporting an empty session', async () => {
    vi.mocked(runSessionPreflight).mockResolvedValue({
      potAvailable: false,
      potProviders: [],
      jsRuntimes: [],
      impersonateTargets: [],
      probeFailed: 'yt-dlp could not be probed for session capabilities.',
    });

    expect(structuredOf(await checkHealthHandler())).toMatchObject({
      session: { probeFailed: 'yt-dlp could not be probed for session capabilities.' },
    });
  });
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

  it('reports which session options are configured, never their values', async () => {
    vi.mocked(readYtDlpEnv).mockReturnValue({
      args: ['--cookies', '/home/u/secret-cookies.txt', '--proxy', 'http://secret:1'],
      cookies: 'file',
      proxy: true,
    });

    const result = await checkHealthHandler();

    expect(structuredOf(result)).toMatchObject({ cookies: 'file', proxy: true });
    expect(textOf(result)).toContain('cookies: file');
    expect(textOf(result)).not.toContain('secret');
  });
});
