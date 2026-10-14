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
import {
  detectScenes,
  MAX_SCENE_CUTS,
  MAX_SCENE_WINDOW_SECONDS,
  parseSceneCuts,
  planScanWindow,
} from '../../src/utils/scenes.js';

describe('parseSceneCuts', () => {
  const showinfo = (time: string): string =>
    `[Parsed_showinfo_1 @ 0x6000] n:   0 pts:  90000 pts_time:${time}   duration: 1 fmt:yuv420p`;

  it('reads the time of each frame ffmpeg selected and shifts it by the window start', () => {
    const stderr = [showinfo('3.5'), 'frame=  1 fps=0.0', showinfo('12.25')].join('\n');

    expect(parseSceneCuts(stderr, 100)).toEqual([103.5, 112.25]);
  });

  it('sorts, de-duplicates and rounds to the millisecond', () => {
    const stderr = [showinfo('9.0004'), showinfo('2'), showinfo('2')].join('\n');

    expect(parseSceneCuts(stderr, 0)).toEqual([2, 9]);
  });

  it('ignores progress and stream lines that merely mention a time', () => {
    expect(parseSceneCuts('time=00:00:05.00 bitrate=N/A\nDuration: 00:10:00', 0)).toEqual([]);
  });
});

describe('planScanWindow', () => {
  it('defaults to the start of the video, up to the cap', () => {
    expect(planScanWindow({}, 3600)).toEqual({ start: 0, end: MAX_SCENE_WINDOW_SECONDS });
  });

  it('defaults the end to the end of a short video', () => {
    expect(planScanWindow({}, 120)).toEqual({ start: 0, end: 120 });
  });

  it('clamps an end past the video', () => {
    expect(planScanWindow({ start: 60, end: 9999 }, 300)).toEqual({ start: 60, end: 300 });
  });

  it('refuses a window longer than the cap, naming the cap', () => {
    expect(() => planScanWindow({ start: 0, end: MAX_SCENE_WINDOW_SECONDS + 1 }, 7200)).toThrow(
      new RegExp(`${MAX_SCENE_WINDOW_SECONDS}`)
    );
  });

  it('refuses a start past the end of the video', () => {
    expect(() => planScanWindow({ start: 400 }, 300)).toThrow(/past the end of this 300s video/);
  });

  it('refuses a window that ends before it starts', () => {
    expect(() => planScanWindow({ start: 50, end: 40 }, 300)).toThrow(
      /end must be later than start/
    );
  });
});

describe('detectScenes', () => {
  const STREAM = 'https://media.example/low.mp4';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVideoInfo).mockResolvedValue({ id: 'v', title: 'T', duration: 600 } as never);
    vi.mocked(requireFfmpeg).mockResolvedValue(undefined);
    vi.mocked(resolveStreamUrl).mockResolvedValue(STREAM);
    vi.mocked(execa).mockResolvedValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('[Parsed_showinfo_1 @ 0x1] n: 0 pts: 1 pts_time:4.5 duration: 1'),
    } as never);
  });

  function argv(): string[] {
    const args = vi.mocked(execa).mock.calls[0]?.[1];
    return Array.isArray(args) ? args.map(String) : [];
  }

  it('returns cuts as absolute video time with the window it scanned', async () => {
    const scan = await detectScenes('v', { start: 100, end: 200, threshold: 0.4 });

    expect(scan).toMatchObject({
      videoId: 'v',
      start: 100,
      end: 200,
      threshold: 0.4,
      cuts: [104.5],
      truncated: false,
    });
  });

  it('seeks and limits the read before the input, behind the https allowlist', async () => {
    await detectScenes('v', { start: 100, end: 160, threshold: 0.3 });

    const args = argv();
    const input = args.indexOf('-i');
    expect(args.indexOf('-ss')).toBeLessThan(input);
    expect(args[args.indexOf('-ss') + 1]).toBe('100');
    expect(args[args.indexOf('-t') + 1]).toBe('60');
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(input);
  });

  it('selects frames by scene score and reports them through showinfo', async () => {
    await detectScenes('v', { threshold: 0.35 });

    const args = argv();
    expect(args[args.indexOf('-vf') + 1]).toBe('select=gt(scene\\,0.35),showinfo');
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
  });

  it(`keeps at most ${MAX_SCENE_CUTS} cuts and says so when it dropped some`, async () => {
    const lines = Array.from(
      { length: MAX_SCENE_CUTS + 5 },
      (_, index) => `[Parsed_showinfo_1 @ 0x1] pts_time:${index + 1}`
    );
    vi.mocked(execa).mockResolvedValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(lines.join('\n')),
    } as never);

    const scan = await detectScenes('v', { threshold: 0.4 });

    expect(scan.cuts).toHaveLength(MAX_SCENE_CUTS);
    expect(scan.truncated).toBe(true);
  });

  it('checks ffmpeg first and never resolves a stream for an impossible window', async () => {
    await expect(detectScenes('v', { start: 9999, threshold: 0.4 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(requireFfmpeg).toHaveBeenCalled();
    expect(resolveStreamUrl).not.toHaveBeenCalled();
  });

  it('wraps an ffmpeg failure and keeps the cause', async () => {
    const cause = new Error('403');
    vi.mocked(execa).mockRejectedValue(cause);

    await expect(detectScenes('v', { threshold: 0.4 })).rejects.toMatchObject({
      code: 'YTDLP_FAILED',
      cause,
    });
  });
});
