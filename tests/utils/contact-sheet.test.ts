import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn(), ExecaError: class extends Error {} }));
vi.mock('../../src/utils/frames.js', () => ({ captureFrames: vi.fn() }));

import { execa } from 'execa';
import { captureFrames } from '../../src/utils/frames.js';
import {
  buildContactSheet,
  captureContactSheet,
  SHEET_TILE_WIDTH,
} from '../../src/utils/contact-sheet.js';

const SHEET = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function filterOf(): string {
  const args = vi.mocked(execa).mock.calls[0]?.[1];
  const argv = Array.isArray(args) ? args.map(String) : [];
  return argv[argv.indexOf('-vf') + 1] ?? '';
}

describe('buildContactSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execa).mockResolvedValue({ stdout: SHEET, stderr: Buffer.alloc(0) } as never);
  });

  it('tiles the frames into a grid with the rows the count needs', async () => {
    const frames = Array.from({ length: 6 }, () => Buffer.from([1]));

    const result = await buildContactSheet(frames, 4);

    expect(result).toMatchObject({ bytes: SHEET, columns: 4, rows: 2 });
    expect(filterOf()).toContain('tile=4x2');
  });

  it('never makes a grid wider than the frames it has', async () => {
    const result = await buildContactSheet([Buffer.from([1]), Buffer.from([2])], 6);

    expect(result).toMatchObject({ columns: 2, rows: 1 });
    expect(filterOf()).toContain('tile=2x1');
  });

  it('feeds the frames to ffmpeg on stdin, in order, and returns one picture', async () => {
    await buildContactSheet([Buffer.from([1, 2]), Buffer.from([3])], 2);

    const call: unknown[] = vi.mocked(execa).mock.calls[0] ?? [];
    expect(call[2]).toMatchObject({ input: Buffer.from([1, 2, 3]) });
    const args = vi.mocked(execa).mock.calls[0]?.[1];
    expect(Array.isArray(args) && args.includes('-frames:v')).toBe(true);
  });

  it('refuses to tile nothing', async () => {
    await expect(buildContactSheet([], 4)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(execa).not.toHaveBeenCalled();
  });

  it('fails when ffmpeg produces no picture', async () => {
    vi.mocked(execa).mockResolvedValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    } as never);

    await expect(buildContactSheet([Buffer.from([1])], 1)).rejects.toMatchObject({
      code: 'YTDLP_FAILED',
    });
  });

  it('wraps an ffmpeg failure and keeps the cause', async () => {
    const cause = new Error('boom');
    vi.mocked(execa).mockRejectedValue(cause);

    await expect(buildContactSheet([Buffer.from([1])], 1)).rejects.toMatchObject({
      code: 'YTDLP_FAILED',
      cause,
    });
  });
});

describe('captureContactSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execa).mockResolvedValue({ stdout: SHEET, stderr: Buffer.alloc(0) } as never);
    vi.mocked(captureFrames).mockResolvedValue({
      videoId: 'v',
      title: 'T',
      duration: 60,
      frames: [
        { timestamp: 10, bytes: Buffer.from([1]) },
        { timestamp: 30, bytes: Buffer.from([2]) },
      ],
    });
  });

  it('captures at tile width and returns the grid with the moment each cell shows', async () => {
    const result = await captureContactSheet('v', { count: 2 }, 4);

    expect(captureFrames).toHaveBeenCalledWith(
      'v',
      { count: 2 },
      expect.objectContaining({ width: SHEET_TILE_WIDTH })
    );
    expect(result).toMatchObject({
      videoId: 'v',
      columns: 2,
      rows: 1,
      timestamps: [10, 30],
      bytes: SHEET,
    });
  });
});
