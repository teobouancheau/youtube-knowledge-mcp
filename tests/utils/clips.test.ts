import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn(), ExecaError: class extends Error {} }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/utils/youtube.js', () => ({
  getVideoInfo: vi.fn(),
  getChapters: vi.fn(),
}));
vi.mock('../../src/utils/preflight.js', () => ({ requireFfmpeg: vi.fn() }));

import { getChapters, getVideoInfo } from '../../src/utils/youtube.js';
import { requireFfmpeg } from '../../src/utils/preflight.js';
import { resolveRange, safeStem } from '../../src/utils/clips.js';
import { YouTubeError } from '../../src/utils/errors.js';

const VIDEO = {
  id: 'dQw4w9WgXcQ',
  title: 'A Talk About Systems',
  channel: 'Channel',
  duration: 600,
  durationFormatted: '10:00',
  uploadDate: '2024-01-01',
  description: '',
  tags: [],
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  thumbnailUrl: '',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
};

describe('safeStem', () => {
  it('keeps an ordinary title intact', () => {
    expect(safeStem('A Talk About Systems', 'fallback')).toBe('A Talk About Systems');
  });

  it.each([
    ['path separators', 'a/b\\c', 'abc'],
    ['Windows-reserved characters', 'a:b|c?d*e"f<g>h%i', 'abcdefghi'],
    ['collapsed whitespace, including tabs and newlines', 'a   b\t\tc\nd', 'a b c d'],
  ])('strips %s', (_label, input, expected) => {
    expect(safeStem(input, 'fallback')).toBe(expected);
  });

  it('strips control characters that would corrupt a filename', () => {
    const title = `title${String.fromCharCode(0)}with${String.fromCharCode(7)}controls`;
    expect(safeStem(title, 'fallback')).toBe('titlewithcontrols');
  });

  it('strips a leading dot, which would hide the file or read as a path', () => {
    expect(safeStem('../../etc/passwd', 'fallback')).toBe('etcpasswd');
  });

  it('caps the length so the path stays valid', () => {
    expect(safeStem('x'.repeat(500), 'fallback')).toHaveLength(80);
  });

  it('falls back when nothing usable survives', () => {
    expect(safeStem('///', 'video123')).toBe('video123');
    expect(safeStem('', 'video123')).toBe('video123');
  });

  it('keeps non-ASCII titles readable', () => {
    expect(safeStem('日本語のタイトル', 'fallback')).toBe('日本語のタイトル');
  });
});

describe('resolveRange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVideoInfo).mockResolvedValue(VIDEO);
    vi.mocked(requireFfmpeg).mockResolvedValue(undefined);
  });

  it('accepts an explicit range', async () => {
    const result = await resolveRange('dQw4w9WgXcQ', { start: 10, end: 20 });
    expect(result.range).toEqual({ start: 10, end: 20 });
  });

  it('resolves a chapter name to its range', async () => {
    vi.mocked(getChapters).mockResolvedValue([
      {
        title: 'Intro',
        startTime: 0,
        startTimeFormatted: '0:00',
        endTime: 60,
        endTimeFormatted: '1:00',
      },
      {
        title: 'The Main Point',
        startTime: 60,
        startTimeFormatted: '1:00',
        endTime: 300,
        endTimeFormatted: '5:00',
      },
    ]);

    const result = await resolveRange('dQw4w9WgXcQ', { chapter: 'main point' });

    expect(result.range).toEqual({ start: 60, end: 300 });
  });

  it('prefers an exact chapter title over a partial match', async () => {
    vi.mocked(getChapters).mockResolvedValue([
      {
        title: 'Intro to Systems',
        startTime: 0,
        startTimeFormatted: '0:00',
        endTime: 60,
        endTimeFormatted: '1:00',
      },
      {
        title: 'Intro',
        startTime: 60,
        startTimeFormatted: '1:00',
        endTime: 120,
        endTimeFormatted: '2:00',
      },
    ]);

    expect((await resolveRange('v', { chapter: 'Intro' })).range.start).toBe(60);
  });

  it('lists the real chapters when the name does not match', async () => {
    vi.mocked(getChapters).mockResolvedValue([
      {
        title: 'Intro',
        startTime: 0,
        startTimeFormatted: '0:00',
        endTime: 60,
        endTimeFormatted: '1:00',
      },
    ]);

    const error = (await resolveRange('v', { chapter: 'nope' }).catch(
      (e: unknown) => e
    )) as YouTubeError;

    expect(error.code).toBe('NOT_FOUND');
    expect(error.toToolMessage()).toContain('Intro');
  });

  it('explains what to do when the video has no chapters', async () => {
    vi.mocked(getChapters).mockResolvedValue([]);

    const error = (await resolveRange('v', { chapter: 'any' }).catch(
      (e: unknown) => e
    )) as YouTubeError;

    expect(error.code).toBe('NOT_FOUND');
    expect(error.toToolMessage()).toContain('start and end');
  });

  it('requires both bounds when no chapter is given', async () => {
    await expect(resolveRange('v', { start: 10 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects an inverted range', async () => {
    await expect(resolveRange('v', { start: 30, end: 10 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects a zero-length range', async () => {
    await expect(resolveRange('v', { start: 10, end: 10 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects a start past the end of the video before spending a download', async () => {
    const error = (await resolveRange('v', { start: 900, end: 950 }).catch(
      (e: unknown) => e
    )) as YouTubeError;

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('600s');
  });

  it('clamps an overshooting end rather than rejecting it', async () => {
    // "the last 30 seconds" is a reasonable thing to ask for imprecisely.
    const result = await resolveRange('v', { start: 550, end: 9999 });
    expect(result.range).toEqual({ start: 550, end: 600 });
  });

  it('does not clamp when the duration is unknown', async () => {
    vi.mocked(getVideoInfo).mockResolvedValue({ ...VIDEO, duration: 0 });
    const result = await resolveRange('v', { start: 0, end: 9999 });
    expect(result.range.end).toBe(9999);
  });
});
