import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';
import type { ClipResult } from '../../src/utils/clips.js';

vi.mock('../../src/utils/clips.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/clips.js')>();
  return {
    ...actual,
    extractClip: vi.fn(),
    extractFrame: vi.fn(),
  };
});
vi.mock('../../src/utils/youtube.js', () => ({ getTranscript: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { writeFile } from 'node:fs/promises';
import { extractClip, extractFrame } from '../../src/utils/clips.js';
import { getTranscript } from '../../src/utils/youtube.js';
import {
  extractAudioClipHandler,
  extractClipHandler,
  extractClipsHandler,
} from '../../src/tools/clips.js';
import { exportSubtitlesHandler, extractFrameHandler } from '../../src/tools/frames-subtitles.js';
import { YouTubeError } from '../../src/utils/errors.js';

const CLIP: ClipResult = {
  videoId: 'dQw4w9WgXcQ',
  title: 'A Talk About Systems',
  filePath: '/home/u/.youtube-knowledge/clips/A Talk [10-20].mp4',
  start: 10,
  end: 20,
  duration: 10,
};

/** The options object the handler passed down to extractClip. */
function clipOptions(call = 0): Record<string, unknown> {
  const options = vi.mocked(extractClip).mock.calls[call]?.[2];
  expect(options).toBeDefined();
  return { ...options };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(extractClip).mockResolvedValue(CLIP);
  vi.mocked(extractFrame).mockResolvedValue({
    videoId: 'dQw4w9WgXcQ',
    title: 'A Talk About Systems',
    filePath: '/home/u/.youtube-knowledge/frames/A Talk [42s].png',
    timestamp: 42,
  });
});

describe('extractClipHandler', () => {
  const args = { video: 'v', quality: '1080p', preciseCuts: false };

  it('reports the clip and where it was written', async () => {
    const result = await extractClipHandler({ ...args, start: '0:10', end: '0:20' });

    expect(textOf(result)).toContain('✓ Clip extracted');
    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      filePath: CLIP.filePath,
      startSeconds: 10,
      endSeconds: 20,
      durationSeconds: 10,
    });
  });

  it('attaches the file as a resource link, not only as a path string', async () => {
    const result = await extractClipHandler({ ...args, start: '0:10', end: '0:20' });
    const link = result.content.find((block) => block.type === 'resource_link');

    expect(link).toMatchObject({ mimeType: 'video/mp4' });
  });

  it('parses timestamps in MM:SS and HH:MM:SS', async () => {
    await extractClipHandler({ ...args, start: '1:02:03', end: '1:02:13' });

    expect(vi.mocked(extractClip).mock.calls[0]?.[1]).toMatchObject({ start: 3723, end: 3733 });
  });

  it('maps a quality preset to a format selector', async () => {
    await extractClipHandler({ ...args, quality: '720p', start: '0:10', end: '0:20' });

    expect(clipOptions().formatSelector).toContain('height<=720');
  });

  it('falls back to 1080p for an unknown preset rather than failing', async () => {
    await extractClipHandler({ ...args, quality: 'nonsense', start: '0:10', end: '0:20' });

    expect(clipOptions().formatSelector).toContain('height<=1080');
  });

  it('passes a chapter through instead of a range', async () => {
    await extractClipHandler({ ...args, chapter: 'The Middle' });

    expect(vi.mocked(extractClip).mock.calls[0]?.[1]).toMatchObject({ chapter: 'The Middle' });
  });

  it('rejects an unparseable timestamp', async () => {
    await expect(
      extractClipHandler({ ...args, start: 'half past four', end: '0:20' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('extractAudioClipHandler', () => {
  const args = { video: 'v', audioFormat: 'mp3' as const, start: '0:10', end: '0:20' };

  it('asks for audio only, in the requested format', async () => {
    await extractAudioClipHandler({ ...args, audioFormat: 'flac' as const });

    expect(clipOptions()).toMatchObject({
      audioOnly: true,
      audioFormat: 'flac',
      formatSelector: 'bestaudio/best',
    });
  });

  it('always cuts precisely, since an audio re-encode is cheap', async () => {
    await extractAudioClipHandler(args);

    expect(clipOptions()).toMatchObject({ preciseCuts: true });
  });

  it('labels the resource link with the audio mime type', async () => {
    const result = await extractAudioClipHandler(args);
    const link = result.content.find((block) => block.type === 'resource_link');

    expect(link).toMatchObject({ mimeType: 'audio/mp3' });
  });

  it('reports the format in the summary', async () => {
    const result = await extractAudioClipHandler({ ...args, audioFormat: 'opus' as const });

    expect(textOf(result)).toContain('opus');
  });
});

describe('extractClipsHandler', () => {
  const args = {
    video: 'v',
    quality: '1080p',
    preciseCuts: false,
    ranges: [
      { start: '0:10', end: '0:20' },
      { start: '0:30', end: '0:40' },
    ],
  };

  it('cuts every requested range', async () => {
    const result = await extractClipsHandler(args);

    expect(structuredOf(result)).toMatchObject({ requested: 2, succeeded: 2 });
    expect(extractClip).toHaveBeenCalledTimes(2);
  });

  it('keeps the clips that succeeded when one range fails', async () => {
    vi.mocked(extractClip)
      .mockResolvedValueOnce(CLIP)
      .mockRejectedValueOnce(new YouTubeError('INVALID_INPUT', 'end must be later than start.'));

    const result = await extractClipsHandler(args);

    // One bad range must not discard the clips that did cut.
    expect(structuredOf(result)).toMatchObject({ requested: 2, succeeded: 1 });
    expect(structuredOf(result).failures).toEqual([
      { start: '0:30', end: '0:40', error: 'INVALID_INPUT' },
    ]);
  });

  it('names the failing range in the summary', async () => {
    vi.mocked(extractClip).mockRejectedValue(
      new YouTubeError('INVALID_INPUT', 'end must be later than start.')
    );

    const result = await extractClipsHandler(args);

    expect(textOf(result)).toContain('0 of 2 clips extracted');
    expect(textOf(result)).toContain('✗ 0:10–0:20');
  });

  it('handles an empty range list without failing', async () => {
    const result = await extractClipsHandler({ ...args, ranges: [] });

    expect(structuredOf(result)).toMatchObject({ requested: 0, succeeded: 0 });
    expect(extractClip).not.toHaveBeenCalled();
  });
});

describe('extractFrameHandler', () => {
  const args = { video: 'v', timestamp: '0:42', format: 'png' as const };

  it('captures the frame and reports the path', async () => {
    const result = await extractFrameHandler(args);

    expect(textOf(result)).toContain('✓ Frame captured');
    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      timestampSeconds: 42,
    });
  });

  it('parses the timestamp before handing it down', async () => {
    await extractFrameHandler({ ...args, timestamp: '1:02:03' });

    expect(vi.mocked(extractFrame).mock.calls[0]?.[1]).toBe(3723);
  });

  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
  ] as const)('labels a %s frame as %s', async (format, mimeType) => {
    const result = await extractFrameHandler({ ...args, format });
    const link = result.content.find((block) => block.type === 'resource_link');

    expect(link).toMatchObject({ mimeType });
  });

  it('rejects an unparseable timestamp before touching the network', async () => {
    await expect(extractFrameHandler({ ...args, timestamp: 'later' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(extractFrame).not.toHaveBeenCalled();
  });
});

describe('exportSubtitlesHandler', () => {
  const args = { video: 'v', format: 'srt' as const, language: 'en' };

  beforeEach(() => {
    vi.mocked(getTranscript).mockResolvedValue({
      transcript: 'first line second line',
      segments: [
        { start: 0, end: 2, text: 'first line' },
        { start: 2, end: 4, text: 'second line' },
      ],
      language: 'en',
      videoId: 'dQw4w9WgXcQ',
      cached: false,
    });
  });

  /** The body handed to writeFile. */
  function written(): string {
    const contents = vi.mocked(writeFile).mock.calls[0]?.[1];
    expect(typeof contents).toBe('string');
    return typeof contents === 'string' ? contents : '';
  }

  it('writes SRT with sequential indices', async () => {
    await exportSubtitlesHandler(args);

    expect(written()).toContain('1\n00:00:00,000 --> 00:00:02,000\nfirst line');
  });

  it('writes WebVTT with the required header', async () => {
    await exportSubtitlesHandler({ ...args, format: 'vtt' });

    expect(written().startsWith('WEBVTT')).toBe(true);
  });

  it('writes plain text with no timings', async () => {
    await exportSubtitlesHandler({ ...args, format: 'txt' });

    expect(written()).toBe('first line second line');
  });

  it('reports the cue count and the file it wrote', async () => {
    const result = await exportSubtitlesHandler(args);

    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      language: 'en',
      format: 'srt',
      cueCount: 2,
    });
    expect(textOf(result)).toContain('2 cues');
  });

  it('names the file after the video, language and format', async () => {
    const result = await exportSubtitlesHandler({ ...args, format: 'vtt', language: 'fr' });

    expect(String(structuredOf(result).filePath)).toContain('dQw4w9WgXcQ.fr.vtt');
  });

  it.each([
    ['srt', 'text/srt'],
    ['vtt', 'text/vtt'],
    ['txt', 'text/plain'],
  ] as const)('labels a %s export as %s', async (format, mimeType) => {
    const result = await exportSubtitlesHandler({ ...args, format });
    const link = result.content.find((block) => block.type === 'resource_link');

    expect(link).toMatchObject({ mimeType });
  });

  it('rejects an output directory outside home before fetching the transcript', async () => {
    await expect(exportSubtitlesHandler({ ...args, outputDir: '/etc' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(getTranscript).not.toHaveBeenCalled();
  });
});
