import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/preflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/preflight.js')>();
  return { ...actual, runPreflight: vi.fn() };
});
vi.mock('../src/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/http.js')>();
  return { ...actual, startHttp: vi.fn() };
});
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    start = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    onmessage?: unknown;
    onclose?: unknown;
    onerror?: unknown;
  },
}));

import { runPreflight } from '../src/utils/preflight.js';
import { startHttp } from '../src/http.js';
import { announcePreflight, getTransportMode, main } from '../src/index.js';

const HEALTHY = {
  ok: true,
  ytDlp: { name: 'yt-dlp', installed: true, version: '2026.07.04' },
  ffmpeg: { name: 'ffmpeg', installed: true, version: '7.1' },
};

const originalArgv = process.argv;
const originalMode = process.env.MCP_MODE;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runPreflight).mockResolvedValue(HEALTHY);
});

afterEach(() => {
  process.argv = originalArgv;
  if (originalMode === undefined) delete process.env.MCP_MODE;
  else process.env.MCP_MODE = originalMode;
});

describe('getTransportMode', () => {
  it('defaults to stdio, which is what a desktop client launches', () => {
    process.argv = ['node', 'index.js'];
    delete process.env.MCP_MODE;

    expect(getTransportMode()).toBe('stdio');
  });

  it.each([
    [['--http'], 'http'],
    [['--stdio'], 'stdio'],
  ] as const)('reads %s as %s', (flags, expected) => {
    process.argv = ['node', 'index.js', ...flags];
    delete process.env.MCP_MODE;

    expect(getTransportMode()).toBe(expected);
  });

  it('reads MCP_MODE when no flag is given', () => {
    process.argv = ['node', 'index.js'];
    process.env.MCP_MODE = 'http';

    expect(getTransportMode()).toBe('http');
  });

  it('lets an explicit flag override the environment', () => {
    // A launcher must always be able to force the mode it needs.
    process.argv = ['node', 'index.js', '--stdio'];
    process.env.MCP_MODE = 'http';

    expect(getTransportMode()).toBe('stdio');
  });

  it('ignores an unrecognised MCP_MODE rather than failing to start', () => {
    process.argv = ['node', 'index.js'];
    process.env.MCP_MODE = 'carrier-pigeon';

    expect(getTransportMode()).toBe('stdio');
  });
});

describe('announcePreflight', () => {
  it('says nothing when both binaries are installed and current', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await announcePreflight();

    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it.each([
    ['yt-dlp is missing', { ...HEALTHY, ok: false, ytDlp: { name: 'yt-dlp', installed: false } }],
    [
      'yt-dlp is stale',
      {
        ...HEALTHY,
        ytDlp: { name: 'yt-dlp', installed: true, version: '2020.01.01', warning: 'out of date' },
      },
    ],
    ['ffmpeg is missing', { ...HEALTHY, ffmpeg: { name: 'ffmpeg', installed: false } }],
  ])('reports to stderr when %s', async (_label, report) => {
    vi.mocked(runPreflight).mockResolvedValue(report);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await announcePreflight();

    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('never throws, so a missing binary cannot stop the server booting', async () => {
    vi.mocked(runPreflight).mockResolvedValue({
      ...HEALTHY,
      ok: false,
      ytDlp: { name: 'yt-dlp', installed: false },
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Exiting here would surface to the user as an opaque "server failed to
    // start" instead of a message naming what to install.
    await expect(announcePreflight()).resolves.toBeUndefined();
    stderr.mockRestore();
  });
});

describe('main', () => {
  it('starts the HTTP transport when asked for', async () => {
    process.argv = ['node', 'index.js', '--http'];

    await main();

    expect(startHttp).toHaveBeenCalled();
  });

  it('starts stdio by default, and no HTTP listener', async () => {
    process.argv = ['node', 'index.js'];
    delete process.env.MCP_MODE;

    await main();

    expect(startHttp).not.toHaveBeenCalled();
  });

  it('runs the preflight check before starting a transport', async () => {
    process.argv = ['node', 'index.js', '--http'];

    await main();

    expect(runPreflight).toHaveBeenCalled();
  });
});
