import { z } from 'zod';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CIRCUIT_STRIKES, onFailure, resetPacer } from '../../src/utils/ytdlp-pacer.js';

// vi.mock is hoisted above imports, so the stand-in class has to be hoisted too.
const { FakeExecaError } = vi.hoisted(() => ({
  FakeExecaError: class FakeExecaError extends Error {
    isCanceled = false;
    timedOut = false;
    code?: string;
    stderr = '';
    shortMessage = 'Command failed';
  },
}));

// runYtDlp narrows failures with `instanceof ExecaError`, so the mock must
// provide a real class rather than a plain object.
vi.mock('execa', () => ({
  execa: vi.fn(),
  ExecaError: FakeExecaError,
}));

type FakeExecaError = InstanceType<typeof FakeExecaError>;

import { execa } from 'execa';
import {
  runYtDlp,
  parseYtDlpJson,
  parseYtDlpJsonLines,
  concurrencyState,
  TIMEOUTS,
} from '../../src/utils/ytdlp.js';

const TARGET = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
import { runWithRequestContext } from '../../src/utils/context.js';
import { YouTubeError } from '../../src/utils/errors.js';

const mockedExeca = vi.mocked(execa);

function ok(stdout: string): never {
  return { stdout } as never;
}

function failWith(overrides: Partial<FakeExecaError>): FakeExecaError {
  return Object.assign(new FakeExecaError('failed'), overrides);
}

describe('runYtDlp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The pacer keeps cooldowns and strike counts across calls on purpose, so
    // a test that throttles it would otherwise slow every test after it.
    resetPacer();
  });

  it('applies a timeout to every call', async () => {
    mockedExeca.mockResolvedValue(ok('output'));

    await runYtDlp(['--version'], { target: TARGET });

    expect(mockedExeca).toHaveBeenCalledWith(
      'yt-dlp',
      ['--socket-timeout', '30', '--version', '--', TARGET],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('bounds socket silence even on transfers that have no wall-clock timeout', async () => {
    // A dead connection is otherwise indistinguishable from a slow one, and it
    // holds its concurrency slot for as long as it stays silent.
    mockedExeca.mockResolvedValue(ok('output'));

    await runYtDlp(['--download'], { target: TARGET, timeoutMs: TIMEOUTS.download });

    expect(mockedExeca).toHaveBeenCalledWith(
      'yt-dlp',
      ['--socket-timeout', '30', '--download', '--', TARGET],
      expect.objectContaining({ timeout: undefined })
    );
  });

  it('omits the timeout only when explicitly disabled, for transfers', async () => {
    mockedExeca.mockResolvedValue(ok('output'));

    await runYtDlp(['-f', 'best'], { target: TARGET, timeoutMs: 0 });

    expect(mockedExeca).toHaveBeenCalledWith(
      'yt-dlp',
      expect.any(Array),
      expect.objectContaining({ timeout: undefined })
    );
  });

  it('reports a timeout as an actionable TIMEOUT rather than a raw execa error', async () => {
    mockedExeca.mockRejectedValue(failWith({ timedOut: true }));

    const error = await runYtDlp(['--version'], { target: TARGET, retry: false }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(YouTubeError);
    expect((error as YouTubeError).code).toBe('TIMEOUT');
  });

  it('explains how to install yt-dlp when the binary is missing', async () => {
    mockedExeca.mockRejectedValue(failWith({ code: 'ENOENT' }));

    const error = (await runYtDlp(['--version'], { target: TARGET, retry: false }).catch(
      (e: unknown) => e
    )) as YouTubeError;

    expect(error.code).toBe('YTDLP_MISSING');
    expect(error.toToolMessage()).toContain('pip install');
  });

  it('retries transient failures and succeeds on a later attempt', async () => {
    mockedExeca
      .mockRejectedValueOnce(failWith({ stderr: 'HTTP Error 429: Too Many Requests' }))
      .mockResolvedValueOnce(ok('recovered'));

    await expect(runYtDlp(['--version'], { target: TARGET })).resolves.toBe('recovered');
    expect(mockedExeca).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt cap', async () => {
    mockedExeca.mockRejectedValue(failWith({ stderr: 'HTTP Error 429: Too Many Requests' }));

    await expect(runYtDlp(['--version'], { target: TARGET })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(mockedExeca).toHaveBeenCalledTimes(3);
  });

  it('refuses to spawn while the circuit is open, and names the likely cause', async () => {
    // Five consecutive refusals mean something structural. Without this a hard
    // block produces an hour of identical failures instead of one message.
    for (let strike = 0; strike < CIRCUIT_STRIKES; strike += 1) onFailure('RATE_LIMITED', 1);
    mockedExeca.mockResolvedValue(ok('should not run'));

    await expect(runYtDlp(['--version'], { target: TARGET })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(mockedExeca).not.toHaveBeenCalled();
  });

  it('waits out a cooldown before spawning new work', async () => {
    onFailure('RATE_LIMITED', 1);
    onFailure('RATE_LIMITED', 2);
    mockedExeca.mockResolvedValue(ok('after the wait'));

    const started = Date.now();
    const pending = runYtDlp(['--version'], { target: TARGET });
    // Cancelling proves the wait is interruptible rather than a wedge.
    const controller = new AbortController();
    controller.abort();

    await expect(Promise.race([pending, Promise.resolve('still waiting')])).resolves.toBe(
      'still waiting'
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('never retries a deterministic failure', async () => {
    // yt_dlp/postprocessor/ffmpeg.py:225 — a missing binary will still be
    // missing on the second attempt, so retrying only wastes the caller's time.
    mockedExeca.mockRejectedValue(
      failWith({
        stderr:
          'ERROR: ffmpeg not found. Please install or provide the path using --ffmpeg-location',
      })
    );

    await expect(runYtDlp(['--version'], { target: TARGET })).rejects.toMatchObject({
      code: 'FFMPEG_MISSING',
    });
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });

  it('does not retry at all when retry is disabled', async () => {
    mockedExeca.mockRejectedValue(failWith({ stderr: 'HTTP Error 429' }));

    await expect(runYtDlp(['-f', 'best'], { target: TARGET, retry: false })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });

  it('forwards the request AbortSignal so cancellation kills the child', async () => {
    mockedExeca.mockResolvedValue(ok('output'));
    const controller = new AbortController();

    await runWithRequestContext({ signal: controller.signal }, () =>
      runYtDlp(['--version'], { target: TARGET })
    );

    expect(mockedExeca).toHaveBeenCalledWith(
      'yt-dlp',
      expect.any(Array),
      expect.objectContaining({ cancelSignal: controller.signal })
    );
  });

  it('refuses to start once the request has been cancelled', async () => {
    mockedExeca.mockResolvedValue(ok('output'));
    const controller = new AbortController();
    controller.abort();

    await expect(
      runWithRequestContext({ signal: controller.signal }, () =>
        runYtDlp(['--version'], { target: TARGET })
      )
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(mockedExeca).not.toHaveBeenCalled();
  });
});

describe('parseYtDlpJson', () => {
  const anyObject = z.record(z.string(), z.unknown());

  it('returns the parsed document when it matches the schema', () => {
    expect(parseYtDlpJson('{"a":1}', anyObject, 'test')).toEqual({ a: 1 });
  });

  it('reports unreadable output as MALFORMED_RESPONSE with the update hint', () => {
    const error = (() => {
      try {
        parseYtDlpJson('{"a":', anyObject, 'video formats');
        return undefined;
      } catch (e) {
        return e as YouTubeError;
      }
    })();

    expect(error?.code).toBe('MALFORMED_RESPONSE');
    expect(error?.toToolMessage()).toContain('yt-dlp -U');
  });

  it('rejects a document of the wrong shape', () => {
    expect(() => parseYtDlpJson('[1,2,3]', anyObject, 'chapters')).toThrow(YouTubeError);
  });

  // The old guard only asked "is it an object", so a field of the wrong type
  // still reached the code that read it as a number.
  it('rejects a field of the wrong type', () => {
    const schema = z.object({ duration: z.number().nullish() });
    expect(() => parseYtDlpJson('{"duration":"long"}', schema, 'video')).toThrow(YouTubeError);
    expect(parseYtDlpJson('{"duration":null}', schema, 'video')).toEqual({ duration: null });
  });
});

describe('parseYtDlpJsonLines', () => {
  const row = z.object({ a: z.number() });

  it('parses one document per line', () => {
    expect(parseYtDlpJsonLines('{"a":1}\n{"a":2}', row)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips lines that do not parse or do not match, keeping the rest', () => {
    expect(parseYtDlpJsonLines('{"a":1}\nnot json\n{"a":"x"}\n{"a":2}', row)).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it('ignores blank lines', () => {
    expect(parseYtDlpJsonLines('\n\n{"a":1}\n\n', row)).toEqual([{ a: 1 }]);
  });
});

describe('concurrency limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPacer();
  });

  it('starts idle', () => {
    expect(concurrencyState()).toMatchObject({ active: 0, queued: 0 });
    expect(concurrencyState().limit).toBeGreaterThan(0);
  });

  it('queues calls beyond the limit instead of spawning them all at once', async () => {
    const { limit } = concurrencyState();

    // Hold every slot open, so the next call has to wait rather than spawn.
    let releaseAll = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    mockedExeca.mockImplementation((() => held.then(() => ok('done'))) as never);

    const inFlight = Array.from({ length: limit + 2 }, () =>
      runYtDlp(['--version'], { target: TARGET })
    );

    // Let the scheduler run so the first `limit` calls have taken their slots.
    await Promise.resolve();
    await Promise.resolve();

    expect(concurrencyState().queued).toBeGreaterThan(0);
    expect(mockedExeca.mock.calls.length).toBeLessThanOrEqual(limit);

    releaseAll();
    await Promise.all(inFlight);

    // Everything eventually runs; the limit paces them, it does not drop them.
    expect(mockedExeca).toHaveBeenCalledTimes(limit + 2);
    expect(concurrencyState()).toMatchObject({ active: 0, queued: 0 });
  });

  it('never exceeds the limit while a slot changes hands', async () => {
    const { limit } = concurrencyState();
    const releases: (() => void)[] = [];
    mockedExeca.mockImplementation(
      (() =>
        new Promise((resolve) => {
          releases.push(() => {
            resolve(ok('done'));
          });
        })) as never
    );

    const inFlight = Array.from({ length: limit * 2 }, () =>
      runYtDlp(['--version'], { target: TARGET })
    );
    await Promise.resolve();
    await Promise.resolve();

    // Freeing slots used to decrement first and wake a waiter afterwards, so
    // for one tick the count sat below the ceiling and a fresh caller could
    // take a slot the queue had already been promised.
    for (let round = 0; round < limit; round++) {
      releases.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(concurrencyState().active).toBeLessThanOrEqual(limit);
    }

    // Anything spawning from here on finishes immediately, so draining the
    // resolvers already collected is enough to settle every call.
    mockedExeca.mockImplementation((() => Promise.resolve(ok('done'))) as never);
    while (releases.length > 0) releases.shift()?.();
    await Promise.all(inFlight);
    expect(concurrencyState()).toMatchObject({ active: 0, queued: 0 });
  });

  it('lets a cancelled request leave the queue instead of waiting for ever', async () => {
    // Media transfers run without a wall-clock timeout, so stalled ones hold
    // their slots indefinitely. When the wait itself ignored the abort signal,
    // every later call queued behind them with no way out and the whole server
    // stopped answering — not just the tool that stalled.
    const { limit } = concurrencyState();
    const releases: (() => void)[] = [];
    mockedExeca.mockImplementation(
      (() =>
        new Promise((resolve) => {
          releases.push(() => {
            resolve(ok('done'));
          });
        })) as never
    );

    const stalled = Array.from({ length: limit }, () =>
      runYtDlp(['--stall'], { target: TARGET, timeoutMs: TIMEOUTS.download }).catch(() => undefined)
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(concurrencyState().active).toBe(limit);

    try {
      const controller = new AbortController();
      const queued = runWithRequestContext({ signal: controller.signal }, () =>
        runYtDlp(['--queued'], { target: TARGET, timeoutMs: TIMEOUTS.download, retry: false })
      );
      await Promise.resolve();
      controller.abort();

      await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(concurrencyState().queued).toBe(0);
    } finally {
      // The stalled transfers still hold every slot; free them, or the rest of
      // the file queues behind them exactly as the server did.
      while (releases.length > 0) releases.shift()?.();
      await Promise.all(stalled);
    }
  });
});

describe('cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPacer();
  });

  it('reports a cancelled child as CANCELLED rather than a generic failure', async () => {
    mockedExeca.mockRejectedValue(failWith({ isCanceled: true }));

    const error = (await runYtDlp(['--version'], { target: TARGET, retry: false }).catch(
      (e: unknown) => e
    )) as YouTubeError;

    expect(error.code).toBe('CANCELLED');
  });

  it('abandons the retry backoff when the request is cancelled mid-wait', async () => {
    const controller = new AbortController();
    mockedExeca.mockImplementation((() => {
      // Cancel while the first failure is backing off, so the wait is what gets
      // interrupted rather than the child.
      queueMicrotask(() => {
        controller.abort();
      });
      return Promise.reject(failWith({ stderr: 'HTTP Error 429: Too Many Requests' }));
    }) as never);

    const error = await runWithRequestContext({ signal: controller.signal }, () =>
      runYtDlp(['--version'], { target: TARGET }).catch((e: unknown) => e)
    );

    expect(error).toMatchObject({ code: 'CANCELLED' });
    // The backoff was cut short rather than slept through to the attempt cap.
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });
});

describe('stderr shapes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPacer();
  });

  it('reads stderr delivered as an array of lines', async () => {
    // execa types stderr by output mode, so it is not always a string.
    mockedExeca.mockRejectedValue(
      failWith({ stderr: ['ERROR: something', 'HTTP Error 429: Too Many Requests'] as never })
    );

    await expect(runYtDlp(['--version'], { target: TARGET, retry: false })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('falls back to the summary when stderr is empty', async () => {
    mockedExeca.mockRejectedValue(
      failWith({ stderr: '', shortMessage: 'HTTP Error 429: Too Many Requests' })
    );

    await expect(runYtDlp(['--version'], { target: TARGET, retry: false })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('ignores a stderr shape it cannot read at all', async () => {
    mockedExeca.mockRejectedValue(failWith({ stderr: 42 as never, shortMessage: '' }));

    await expect(runYtDlp(['--version'], { target: TARGET, retry: false })).rejects.toMatchObject({
      code: 'YTDLP_FAILED',
    });
  });
});

describe('backoff interruption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPacer();
  });

  it('cuts the backoff short the moment the request is cancelled', async () => {
    const controller = new AbortController();
    let attempts = 0;

    mockedExeca.mockImplementation((() => {
      attempts++;
      // Abort once the failure is in flight, so the abort lands while the
      // retry is sleeping rather than before the attempt starts.
      setTimeout(() => {
        controller.abort();
      }, 0);
      return Promise.reject(failWith({ stderr: 'HTTP Error 429: Too Many Requests' }));
    }) as never);

    const started = Date.now();
    const error = await runWithRequestContext({ signal: controller.signal }, () =>
      runYtDlp(['--version'], { target: TARGET }).catch((e: unknown) => e)
    );

    expect(error).toMatchObject({ code: 'CANCELLED' });
    expect(attempts).toBe(1);
    // The first backoff is measured in hundreds of ms; waking immediately is
    // the whole point of threading the signal into the sleep.
    expect(Date.now() - started).toBeLessThan(400);
  });
});

describe('runYtDlp target handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPacer();
  });

  it('places session flags before the caller arguments and never after the terminator', async () => {
    mockedExeca.mockResolvedValue({ stdout: '' } as never);
    process.env.YOUTUBE_MCP_COOKIES_FROM_BROWSER = 'firefox';
    try {
      await runYtDlp(['--skip-download'], { target: TARGET });
    } finally {
      delete process.env.YOUTUBE_MCP_COOKIES_FROM_BROWSER;
    }

    const argv = mockedExeca.mock.calls[0]?.[1];
    const list = Array.isArray(argv) ? argv : [];
    const cookiesAt = list.indexOf('--cookies-from-browser');
    expect(cookiesAt).toBeGreaterThan(-1);
    expect(cookiesAt).toBeLessThan(list.indexOf('--skip-download'));
    expect(list.slice(-2)).toEqual(['--', TARGET]);
  });

  it('places a literal -- immediately before the target', async () => {
    mockedExeca.mockResolvedValue({ stdout: '' } as never);

    await runYtDlp(['--skip-download', '-j'], { target: TARGET });

    const argv = mockedExeca.mock.calls[0]?.[1];
    expect(Array.isArray(argv) ? argv.slice(-2) : []).toEqual(['--', TARGET]);
  });

  // The whole point of the terminator: a caller-controlled value that looks
  // like an option reaches yt-dlp as a URL it cannot fetch, never as a flag.
  it('passes a flag-shaped target as the target, after the terminator', async () => {
    mockedExeca.mockResolvedValue({ stdout: '' } as never);

    await runYtDlp(['--version'], { target: '--exec=id' });

    const argv = mockedExeca.mock.calls[0]?.[1];
    const list = Array.isArray(argv) ? argv : [];
    expect(list.slice(-2)).toEqual(['--', '--exec=id']);
    expect(list.filter((arg) => arg === '--exec=id')).toHaveLength(1);
  });
});
