import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn(), ExecaError: class extends Error {} }));

import { execa } from 'execa';
import { runWithRequestContext } from '../../src/utils/context.js';
import { runFfmpeg, type FfmpegRun } from '../../src/utils/ffmpeg.js';

const RUN: FfmpegRun = {
  failure: 'ffmpeg could not do the thing.',
  nextStep: 'Try the other thing.',
  timeoutMs: 5_000,
};

const optionsOf = (): Record<string, unknown> => {
  const call: unknown[] = vi.mocked(execa).mock.calls[0] ?? [];
  return (call[2] ?? {}) as Record<string, unknown>;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execa).mockResolvedValue({
    stdout: Uint8Array.from([1, 2]),
    stderr: new TextEncoder().encode('frame info'),
  } as never);
});

describe('runFfmpeg', () => {
  it('runs ffmpeg with the arguments, as bytes, within the time budget', async () => {
    await runFfmpeg(['-i', 'x'], RUN);

    expect(vi.mocked(execa).mock.calls[0]?.[0]).toBe('ffmpeg');
    expect(vi.mocked(execa).mock.calls[0]?.[1]).toEqual(['-i', 'x']);
    expect(optionsOf()).toMatchObject({ encoding: 'buffer', timeout: 5_000 });
  });

  it('returns what ffmpeg wrote, stdout as bytes and stderr as text', async () => {
    const { stdout, stderr } = await runFfmpeg([], RUN);

    expect(stdout.equals(Buffer.from([1, 2]))).toBe(true);
    expect(stderr).toBe('frame info');
  });

  it('hands ffmpeg its standard input when there is some, and not otherwise', async () => {
    await runFfmpeg([], { ...RUN, input: Uint8Array.from([9]) });
    expect(optionsOf()).toHaveProperty('input');

    vi.clearAllMocks();
    await runFfmpeg([], RUN);
    expect(optionsOf()).not.toHaveProperty('input');
  });

  it('stops the process when the client cancels the request', async () => {
    const controller = new AbortController();

    await runWithRequestContext({ signal: controller.signal }, () => runFfmpeg([], RUN));

    expect(optionsOf().cancelSignal).toBe(controller.signal);
  });

  it('reports a failure as a typed error with the next step, keeping the cause', async () => {
    const cause = new Error('Server returned 403');
    vi.mocked(execa).mockRejectedValue(cause);

    await expect(runFfmpeg([], RUN)).rejects.toMatchObject({
      code: 'YTDLP_FAILED',
      message: 'ffmpeg could not do the thing.',
      nextStep: 'Try the other thing.',
      cause,
    });
  });
});
