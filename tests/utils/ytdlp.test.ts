import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { runYtDlp, parseYtDlpJson, parseYtDlpJsonLines, isRecord } from '../../src/utils/ytdlp.js';
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
  });

  it('applies a timeout to every call', async () => {
    mockedExeca.mockResolvedValue(ok('output'));

    await runYtDlp(['--version']);

    expect(mockedExeca).toHaveBeenCalledWith(
      'yt-dlp',
      ['--version'],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('omits the timeout only when explicitly disabled, for transfers', async () => {
    mockedExeca.mockResolvedValue(ok('output'));

    await runYtDlp(['-f', 'best'], { timeoutMs: 0 });

    expect(mockedExeca).toHaveBeenCalledWith(
      'yt-dlp',
      expect.any(Array),
      expect.objectContaining({ timeout: undefined })
    );
  });

  it('reports a timeout as an actionable TIMEOUT rather than a raw execa error', async () => {
    mockedExeca.mockRejectedValue(failWith({ timedOut: true }));

    const error = await runYtDlp(['--version'], { retry: false }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(YouTubeError);
    expect((error as YouTubeError).code).toBe('TIMEOUT');
  });

  it('explains how to install yt-dlp when the binary is missing', async () => {
    mockedExeca.mockRejectedValue(failWith({ code: 'ENOENT' }));

    const error = (await runYtDlp(['--version'], { retry: false }).catch(
      (e: unknown) => e
    )) as YouTubeError;

    expect(error.code).toBe('YTDLP_MISSING');
    expect(error.toToolMessage()).toContain('pip install');
  });

  it('retries transient failures and succeeds on a later attempt', async () => {
    mockedExeca
      .mockRejectedValueOnce(failWith({ stderr: 'HTTP Error 429: Too Many Requests' }))
      .mockResolvedValueOnce(ok('recovered'));

    await expect(runYtDlp(['--version'])).resolves.toBe('recovered');
    expect(mockedExeca).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt cap', async () => {
    mockedExeca.mockRejectedValue(failWith({ stderr: 'HTTP Error 429: Too Many Requests' }));

    await expect(runYtDlp(['--version'])).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(mockedExeca).toHaveBeenCalledTimes(3);
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

    await expect(runYtDlp(['--version'])).rejects.toMatchObject({ code: 'FFMPEG_MISSING' });
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });

  it('does not retry at all when retry is disabled', async () => {
    mockedExeca.mockRejectedValue(failWith({ stderr: 'HTTP Error 429' }));

    await expect(runYtDlp(['-f', 'best'], { retry: false })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });

  it('forwards the request AbortSignal so cancellation kills the child', async () => {
    mockedExeca.mockResolvedValue(ok('output'));
    const controller = new AbortController();

    await runWithRequestContext({ signal: controller.signal }, () => runYtDlp(['--version']));

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
      runWithRequestContext({ signal: controller.signal }, () => runYtDlp(['--version']))
    ).rejects.toThrow();
    expect(mockedExeca).not.toHaveBeenCalled();
  });
});

describe('parseYtDlpJson', () => {
  it('parses well-formed JSON', () => {
    expect(parseYtDlpJson('{"a":1}', isRecord, 'test')).toEqual({ a: 1 });
  });

  it('turns a SyntaxError into an actionable MALFORMED_RESPONSE', () => {
    // Truncated yt-dlp output used to surface as a bare SyntaxError.
    const error = (() => {
      try {
        parseYtDlpJson('{"a":', isRecord, 'video formats');
        return undefined;
      } catch (e) {
        return e as YouTubeError;
      }
    })();

    expect(error?.code).toBe('MALFORMED_RESPONSE');
    expect(error?.message).toContain('video formats');
    expect(error?.toToolMessage()).toContain('yt-dlp -U');
  });

  it('rejects valid JSON of the wrong shape', () => {
    expect(() => parseYtDlpJson('[1,2,3]', isRecord, 'chapters')).toThrow(YouTubeError);
  });
});

describe('parseYtDlpJsonLines', () => {
  it('parses newline-delimited JSON', () => {
    expect(parseYtDlpJsonLines('{"a":1}\n{"a":2}', isRecord)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('drops a malformed row instead of losing the whole result set', () => {
    expect(parseYtDlpJsonLines('{"a":1}\nnot json\n{"a":2}', isRecord)).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it('ignores blank lines', () => {
    expect(parseYtDlpJsonLines('\n\n{"a":1}\n\n', isRecord)).toEqual([{ a: 1 }]);
  });
});

describe('isRecord', () => {
  it.each([
    [{}, true],
    [{ a: 1 }, true],
    [[], false],
    [null, false],
    ['string', false],
    [42, false],
  ])('classifies %o as %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a cancelled child as CANCELLED rather than a generic failure', async () => {
    mockedExeca.mockRejectedValue(failWith({ isCanceled: true }));

    const error = (await runYtDlp(['--version'], { retry: false }).catch(
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
      runYtDlp(['--version']).catch((e: unknown) => e)
    );

    expect(error).toMatchObject({ code: 'CANCELLED' });
    // The backoff was cut short rather than slept through to the attempt cap.
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });
});

describe('backoff interruption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      runYtDlp(['--version']).catch((e: unknown) => e)
    );

    expect(error).toMatchObject({ code: 'CANCELLED' });
    expect(attempts).toBe(1);
    // The first backoff is measured in hundreds of ms; waking immediately is
    // the whole point of threading the signal into the sleep.
    expect(Date.now() - started).toBeLessThan(400);
  });
});
