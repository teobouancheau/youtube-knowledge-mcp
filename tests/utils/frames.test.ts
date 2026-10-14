import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn(), ExecaError: class extends Error {} }));
vi.mock('../../src/utils/youtube.js', () => ({ getVideoInfo: vi.fn() }));
vi.mock('../../src/utils/preflight.js', () => ({ requireFfmpeg: vi.fn() }));
vi.mock('../../src/utils/video-stream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/video-stream.js')>()),
  resolveStreamUrl: vi.fn(),
}));

import { execa } from 'execa';
import { getVideoInfo } from '../../src/utils/youtube.js';
import { requireFfmpeg } from '../../src/utils/preflight.js';
import { resolveStreamUrl } from '../../src/utils/video-stream.js';
import { captureFrames } from '../../src/utils/frames.js';

const VIDEO = {
  id: 'dQw4w9WgXcQ',
  title: 'A Talk About Systems',
  duration: 600,
};
const STREAM = 'https://media.example/stream.mp4';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function ffmpegCalls(): string[][] {
  return vi
    .mocked(execa)
    .mock.calls.filter(([command]) => command === 'ffmpeg')
    .map(([, args]) => (Array.isArray(args) ? args.map(String) : []));
}

describe('captureFrames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVideoInfo).mockResolvedValue(VIDEO as never);
    vi.mocked(requireFfmpeg).mockResolvedValue(undefined);
    vi.mocked(resolveStreamUrl).mockResolvedValue(STREAM);
    vi.mocked(execa).mockResolvedValue({ stdout: JPEG, stderr: Buffer.alloc(0) } as never);
  });

  const options = { width: 640, maxFrames: 12, label: 'Frame capture' };

  it('returns one frame per planned timestamp, in order, with the bytes ffmpeg produced', async () => {
    const batch = await captureFrames('v', { timestamps: [30, 10, 20] }, options);

    expect(batch).toMatchObject({ videoId: VIDEO.id, title: VIDEO.title });
    expect(batch.frames.map((frame) => frame.timestamp)).toEqual([10, 20, 30]);
    expect(batch.frames.every((frame) => frame.bytes.equals(JPEG))).toBe(true);
  });

  it('streams the picture back on stdout instead of writing a file', async () => {
    await captureFrames('v', { timestamps: [5] }, options);

    const argv = ffmpegCalls()[0] ?? [];
    expect(argv).toContain('pipe:1');
    expect(argv[argv.indexOf('-f') + 1]).toBe('image2pipe');
    expect(argv).toContain(STREAM);
  });

  it('seeks before the input, behind an https-only allowlist', async () => {
    await captureFrames('v', { timestamps: [42] }, options);

    const argv = ffmpegCalls()[0] ?? [];
    const input = argv.indexOf('-i');
    expect(argv.indexOf('-ss')).toBeLessThan(input);
    expect(argv.indexOf('-protocol_whitelist')).toBeLessThan(input);
    expect(argv[argv.indexOf('-ss') + 1]).toBe('42');
  });

  it('shrinks to the requested width without ever enlarging', async () => {
    await captureFrames('v', { timestamps: [5] }, options);

    const argv = ffmpegCalls()[0] ?? [];
    expect(argv[argv.indexOf('-vf') + 1]).toBe('scale=min(640\\,iw):-2');
  });

  it('checks ffmpeg before doing any network work', async () => {
    vi.mocked(requireFfmpeg).mockRejectedValue(new Error('no ffmpeg'));

    await expect(captureFrames('v', { timestamps: [5] }, options)).rejects.toThrow('no ffmpeg');
    expect(getVideoInfo).not.toHaveBeenCalled();
    expect(resolveStreamUrl).not.toHaveBeenCalled();
  });

  it('does not resolve a stream for a request that cannot be planned', async () => {
    await expect(captureFrames('v', { timestamps: [9999] }, options)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(resolveStreamUrl).not.toHaveBeenCalled();
  });

  it('fails when ffmpeg produces no picture, naming the moment', async () => {
    vi.mocked(execa).mockResolvedValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    } as never);

    await expect(captureFrames('v', { timestamps: [77] }, options)).rejects.toMatchObject({
      code: 'YTDLP_FAILED',
      message: expect.stringContaining('77s'),
    });
  });

  it('wraps an ffmpeg failure and keeps the cause', async () => {
    const cause = new Error('Server returned 403');
    vi.mocked(execa).mockRejectedValue(cause);

    await expect(captureFrames('v', { timestamps: [5] }, options)).rejects.toMatchObject({
      code: 'YTDLP_FAILED',
      cause,
    });
  });
});
