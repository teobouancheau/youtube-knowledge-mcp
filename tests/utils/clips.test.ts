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
import { extractClip, extractFrame, resolveRange, safeStem } from '../../src/utils/clips.js';
import { execa } from 'execa';
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

describe('extractClip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVideoInfo).mockResolvedValue(VIDEO);
    vi.mocked(requireFfmpeg).mockResolvedValue(undefined);
  });

  /** The download call returns nothing; the follow-up prints the filename. */
  function ytDlpReturns(filename: string): void {
    vi.mocked(execa)
      .mockResolvedValueOnce({ stdout: '' } as never)
      .mockResolvedValueOnce({ stdout: filename } as never);
  }

  /** The argv of the nth yt-dlp invocation. */
  function argvOf(call: number): string[] {
    const args = vi.mocked(execa).mock.calls[call]?.[1];
    expect(Array.isArray(args)).toBe(true);
    return Array.isArray(args) ? args : [];
  }

  const OPTIONS = {
    formatSelector: 'bestvideo+bestaudio',
    preciseCuts: false,
    container: 'mp4',
  };

  it('refuses before touching the network when ffmpeg is missing', async () => {
    vi.mocked(requireFfmpeg).mockRejectedValue(
      new YouTubeError('FFMPEG_MISSING', 'ffmpeg is not installed.')
    );

    await expect(extractClip('v', { start: 10, end: 20 }, OPTIONS)).rejects.toMatchObject({
      code: 'FFMPEG_MISSING',
    });
    expect(execa).not.toHaveBeenCalled();
  });

  it('asks yt-dlp for only the requested section', async () => {
    ytDlpReturns('/home/u/.youtube-knowledge/clips/A Talk About Systems [10-20].mp4');

    await extractClip('v', { start: 10, end: 20 }, OPTIONS);

    // The point of the tool: fetch the byte range, not the whole video.
    expect(argvOf(0)).toContain('--download-sections');
    expect(argvOf(0)).toContain('*00:00:10.000-00:00:20.000');
  });

  it('reports the range it actually cut', async () => {
    ytDlpReturns('/clips/clip.mp4');

    const result = await extractClip('v', { start: 10, end: 20 }, OPTIONS);

    expect(result).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      title: 'A Talk About Systems',
      start: 10,
      end: 20,
      duration: 10,
    });
  });

  it('cuts on keyframes by default, since precision costs a re-encode', async () => {
    ytDlpReturns('/clips/clip.mp4');

    await extractClip('v', { start: 10, end: 20 }, OPTIONS);

    expect(argvOf(0)).not.toContain('--force-keyframes-at-cuts');
  });

  it('re-encodes for an exact cut when asked', async () => {
    ytDlpReturns('/clips/clip.mp4');

    await extractClip('v', { start: 10, end: 20 }, { ...OPTIONS, preciseCuts: true });

    expect(argvOf(0)).toContain('--force-keyframes-at-cuts');
  });

  it('remuxes into the requested container', async () => {
    ytDlpReturns('/clips/clip.mkv');

    await extractClip('v', { start: 10, end: 20 }, { ...OPTIONS, container: 'mkv' });

    const argv = argvOf(0);
    expect(argv).toContain('--merge-output-format');
    expect(argv[argv.indexOf('--merge-output-format') + 1]).toBe('mkv');
  });

  it('extracts audio instead of remuxing video when audioOnly is set', async () => {
    ytDlpReturns('/clips/clip.mp3');

    await extractClip(
      'v',
      { start: 10, end: 20 },
      { ...OPTIONS, audioOnly: true, audioFormat: 'flac' }
    );

    const argv = argvOf(0);
    expect(argv).toContain('--extract-audio');
    expect(argv[argv.indexOf('--audio-format') + 1]).toBe('flac');
    expect(argv).not.toContain('--merge-output-format');
  });

  it('defaults an audio clip to mp3', async () => {
    ytDlpReturns('/clips/clip.mp3');

    await extractClip('v', { start: 10, end: 20 }, { ...OPTIONS, audioOnly: true });

    expect(argvOf(0)[argvOf(0).indexOf('--audio-format') + 1]).toBe('mp3');
  });

  it('corrects the extension yt-dlp reports to the container actually written', async () => {
    // yt-dlp prints the pre-merge filename, so its extension is the intermediate
    // one; reporting it verbatim would hand back a path that does not exist.
    ytDlpReturns('/home/u/clips/A Talk [10-20].webm');

    const result = await extractClip('v', { start: 10, end: 20 }, OPTIONS);

    expect(result.filePath).toBe('/home/u/clips/A Talk [10-20].mp4');
  });

  it('falls back to a computed path when yt-dlp prints no filename', async () => {
    ytDlpReturns('   ');

    const result = await extractClip('v', { start: 10, end: 20 }, OPTIONS);

    expect(result.filePath).toContain('A Talk About Systems [10-20].mp4');
  });

  it('resolves a chapter name to its range', async () => {
    vi.mocked(getChapters).mockResolvedValue([
      {
        title: 'The Middle',
        startTime: 100,
        endTime: 200,
        startTimeFormatted: '1:40',
        endTimeFormatted: '3:20',
      },
    ]);
    ytDlpReturns('/clips/clip.mp4');

    const result = await extractClip('v', { chapter: 'The Middle' }, OPTIONS);

    expect(result).toMatchObject({ start: 100, end: 200 });
  });

  it('does not retry a failed transfer over a partial file', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('network died'));

    await expect(extractClip('v', { start: 10, end: 20 }, OPTIONS)).rejects.toThrow();
    // One attempt only: retrying would resume onto a half-written clip.
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it('rejects an output directory outside the home directory', async () => {
    await expect(
      extractClip('v', { start: 10, end: 20 }, { ...OPTIONS, outputDir: '/etc' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(execa).not.toHaveBeenCalled();
  });
});

describe('extractFrame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVideoInfo).mockResolvedValue(VIDEO);
    vi.mocked(requireFfmpeg).mockResolvedValue(undefined);
  });

  it('resolves a stream URL and hands it to ffmpeg rather than downloading', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({ stdout: 'https://media.example/stream.mp4' } as never)
      .mockResolvedValueOnce({ stdout: '' } as never);

    const result = await extractFrame('v', 42, { format: 'png' });

    const [command, argv] = vi.mocked(execa).mock.calls[1] ?? [];
    expect(command).toBe('ffmpeg');
    expect(argv).toContain('https://media.example/stream.mp4');
    // -ss before -i seeks without decoding everything up to that point.
    expect(Array.isArray(argv) && argv.indexOf('-ss') < argv.indexOf('-i')).toBe(true);
    expect(result).toMatchObject({ videoId: 'dQw4w9WgXcQ', timestamp: 42 });
  });

  it('names the file after the video, the timestamp and the format', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({ stdout: 'https://media.example/s.mp4' } as never)
      .mockResolvedValueOnce({ stdout: '' } as never);

    const result = await extractFrame('v', 42.7, { format: 'jpg' });

    expect(result.filePath).toContain('A Talk About Systems [43s].jpg');
  });

  it('takes the first URL when yt-dlp resolves separate streams', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({
        stdout: 'https://video.example/v\nhttps://audio.example/a',
      } as never)
      .mockResolvedValueOnce({ stdout: '' } as never);

    await extractFrame('v', 10, { format: 'png' });

    expect(vi.mocked(execa).mock.calls[1]?.[1]).toContain('https://video.example/v');
  });

  it('refuses a timestamp past the end of the video', async () => {
    const error = (await extractFrame('v', 9999, { format: 'png' }).catch(
      (e: unknown) => e
    )) as YouTubeError;

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('600s');
  });

  it('allows any timestamp when the duration is unknown', async () => {
    vi.mocked(getVideoInfo).mockResolvedValue({ ...VIDEO, duration: 0 });
    vi.mocked(execa)
      .mockResolvedValueOnce({ stdout: 'https://media.example/s.mp4' } as never)
      .mockResolvedValueOnce({ stdout: '' } as never);

    await expect(extractFrame('v', 9999, { format: 'png' })).resolves.toBeDefined();
  });

  it('explains a stream that could not be resolved', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: '' } as never);

    const error = (await extractFrame('v', 10, { format: 'png' }).catch(
      (e: unknown) => e
    )) as YouTubeError;

    expect(error.code).toBe('YTDLP_FAILED');
    expect(error.toToolMessage()).toContain('check_health');
  });

  it('reports an ffmpeg failure as an actionable error rather than a raw throw', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({ stdout: 'https://media.example/s.mp4' } as never)
      .mockRejectedValueOnce(new Error('ffmpeg exploded'));

    const error = (await extractFrame('v', 10, { format: 'png' }).catch(
      (e: unknown) => e
    )) as YouTubeError;

    expect(error.code).toBe('YTDLP_FAILED');
    expect(error.toToolMessage()).toContain('ffmpeg');
    expect(error.toToolMessage()).not.toContain('exploded');
  });

  it('refuses before touching the network when ffmpeg is missing', async () => {
    vi.mocked(requireFfmpeg).mockRejectedValue(
      new YouTubeError('FFMPEG_MISSING', 'ffmpeg is not installed.')
    );

    await expect(extractFrame('v', 10, { format: 'png' })).rejects.toMatchObject({
      code: 'FFMPEG_MISSING',
    });
    expect(execa).not.toHaveBeenCalled();
  });
});
