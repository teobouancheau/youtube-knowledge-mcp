import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn(), ExecaError: class extends Error {} }));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/utils/preflight.js', () => ({ requireFfmpeg: vi.fn() }));
vi.mock('../../src/utils/clips.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/clips.js')>()),
  resolveRange: vi.fn(),
}));
vi.mock('../../src/utils/video-stream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/video-stream.js')>()),
  resolveStreamUrl: vi.fn(),
}));

import { execa } from 'execa';
import { rm, stat } from 'node:fs/promises';
import { requireFfmpeg } from '../../src/utils/preflight.js';
import { resolveRange } from '../../src/utils/clips.js';
import { resolveStreamUrl } from '../../src/utils/video-stream.js';
import { MAX_GIF_SECONDS, extractGif } from '../../src/utils/gif.js';

const STREAM = 'https://media.example/stream.mp4';

function range(start: number, end: number): void {
  vi.mocked(resolveRange).mockResolvedValue({
    range: { start, end },
    title: 'A Talk About Systems',
    videoId: 'dQw4w9WgXcQ',
    duration: 600,
  });
}

function argv(): string[] {
  const args = vi.mocked(execa).mock.calls[0]?.[1];
  return Array.isArray(args) ? args.map(String) : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireFfmpeg).mockResolvedValue(undefined);
  vi.mocked(resolveStreamUrl).mockResolvedValue(STREAM);
  vi.mocked(execa).mockResolvedValue({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } as never);
  vi.mocked(stat).mockResolvedValue({ size: 123_456 } as never);
  range(10, 14);
});

const options = { width: 480, fps: 12 };

describe('extractGif', () => {
  it('cuts the range from the stream without downloading the video, behind the https allowlist', async () => {
    await extractGif('v', { start: 10, end: 14 }, options);

    const args = argv();
    const input = args.indexOf('-i');
    expect(args).toContain(STREAM);
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(input);
    expect(args[args.indexOf('-ss') + 1]).toBe('10');
    expect(args[args.indexOf('-t') + 1]).toBe('4');
    expect(args.indexOf('-ss')).toBeLessThan(input);
  });

  it('builds the palette from the clip itself, so the colours are not the default 256', async () => {
    await extractGif('v', { start: 10, end: 14 }, { width: 320, fps: 8 });

    const filter = argv()[argv().indexOf('-vf') + 1] ?? '';
    expect(filter).toContain('fps=8');
    expect(filter).toContain('scale=320:-1');
    expect(filter).toContain('palettegen');
    expect(filter).toContain('paletteuse');
  });

  it('loops forever, as a GIF is expected to', async () => {
    await extractGif('v', { start: 10, end: 14 }, options);

    expect(argv()[argv().indexOf('-loop') + 1]).toBe('0');
  });

  it('names the file after the video and the range, and reports its size', async () => {
    const result = await extractGif('v', { start: 10, end: 14 }, options);

    expect(result).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      title: 'A Talk About Systems',
      start: 10,
      end: 14,
      duration: 4,
      width: 480,
      fps: 12,
      bytes: 123_456,
    });
    expect(result.filePath).toMatch(/A Talk About Systems \[10-14\]\.gif$/);
    expect(argv().at(-1)).toBe(result.filePath);
  });

  it('refuses a range longer than a GIF should be, before any network work', async () => {
    range(0, MAX_GIF_SECONDS + 1);

    await expect(
      extractGif('v', { start: 0, end: MAX_GIF_SECONDS + 1 }, options)
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining(String(MAX_GIF_SECONDS)),
    });
    expect(resolveStreamUrl).not.toHaveBeenCalled();
    expect(execa).not.toHaveBeenCalled();
  });

  it('checks ffmpeg before anything else', async () => {
    vi.mocked(requireFfmpeg).mockRejectedValue(new Error('no ffmpeg'));

    await expect(extractGif('v', { start: 10, end: 14 }, options)).rejects.toThrow('no ffmpeg');
    expect(resolveRange).not.toHaveBeenCalled();
  });

  it('removes the half-written GIF when ffmpeg fails, so a broken file is never left to be shared', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('boom'));

    await expect(extractGif('v', { start: 10, end: 14 }, options)).rejects.toMatchObject({
      code: 'YTDLP_FAILED',
    });
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/\.gif$/), { force: true });
  });

  it('stops ffmpeg when the client cancels, not only when it times out', async () => {
    await extractGif('v', { start: 10, end: 14 }, options);

    const call: unknown[] = vi.mocked(execa).mock.calls[0] ?? [];
    expect(call[2]).toHaveProperty('cancelSignal');
  });

  it('wraps an ffmpeg failure and keeps the cause', async () => {
    const cause = new Error('boom');
    vi.mocked(execa).mockRejectedValue(cause);

    await expect(extractGif('v', { start: 10, end: 14 }, options)).rejects.toMatchObject({
      code: 'YTDLP_FAILED',
      cause,
    });
  });
});
