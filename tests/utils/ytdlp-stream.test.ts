import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('execa', () => ({ execa: vi.fn(), ExecaError: class extends Error {} }));

import { execa } from 'execa';
import { runYtDlpLines } from '../../src/utils/ytdlp-stream.js';
import { concurrencyState } from '../../src/utils/ytdlp.js';

const mockedExeca = vi.mocked(execa);

/** A child whose stdout yields `lines`, then settles as `outcome` says. */
function child(lines: string[], outcome: 'ok' | 'fail' = 'ok'): unknown {
  const stdout = Readable.from(lines.map((line) => `${line}\n`));
  const settled =
    outcome === 'ok' ? Promise.resolve({ stdout: '' }) : Promise.reject(new Error('walk died'));
  return Object.assign(settled, { stdout });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runYtDlpLines', () => {
  it('hands over each line as it arrives', async () => {
    mockedExeca.mockReturnValue(child(['a', 'b', 'c']) as never);
    const seen: string[] = [];

    const result = await runYtDlpLines(['--flat-playlist'], {
      target: 'https://youtube.com/@x',
      onLine: (line) => seen.push(line),
    });

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(result).toEqual({ lines: 3, completed: true });
  });

  it('keeps what it delivered when the walk dies part-way', async () => {
    // The reason streaming exists: a 40,000-entry listing killed at minute
    // nine used to yield nothing at all.
    mockedExeca.mockReturnValue(child(['a', 'b'], 'fail') as never);
    const seen: string[] = [];

    const result = await runYtDlpLines([], {
      target: 'https://youtube.com/@x',
      onLine: (line) => seen.push(line),
    });

    expect(seen).toEqual(['a', 'b']);
    expect(result).toEqual({ lines: 2, completed: false });
  });

  it('skips blank lines rather than counting them as entries', async () => {
    mockedExeca.mockReturnValue(child(['a', '', '   ', 'b']) as never);

    const result = await runYtDlpLines([], {
      target: 'https://youtube.com/@x',
      onLine: () => undefined,
    });

    expect(result.lines).toBe(2);
  });

  it('puts session flags first and the target behind the terminator', async () => {
    mockedExeca.mockReturnValue(child(['a']) as never);

    await runYtDlpLines(['--flat-playlist'], {
      target: 'https://youtube.com/@x',
      onLine: () => undefined,
    });

    const argv = mockedExeca.mock.calls[0]?.[1] as string[];
    expect(argv.at(-2)).toBe('--');
    expect(argv.at(-1)).toBe('https://youtube.com/@x');
    expect(argv.indexOf('--socket-timeout')).toBe(0);
  });

  it('refuses to start on an already-cancelled request', async () => {
    const { runWithRequestContext } = await import('../../src/utils/context.js');
    const controller = new AbortController();
    controller.abort();
    mockedExeca.mockReturnValue(child(['a']) as never);

    await expect(
      runWithRequestContext({ signal: controller.signal }, () =>
        runYtDlpLines([], { target: 'https://youtube.com/@x', onLine: () => undefined })
      )
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(mockedExeca).not.toHaveBeenCalled();
  });

  it('releases its concurrency slot even when the walk fails', async () => {
    mockedExeca.mockReturnValue(child(['a'], 'fail') as never);

    await runYtDlpLines([], { target: 'https://youtube.com/@x', onLine: () => undefined });

    expect(concurrencyState().active).toBe(0);
  });
});
