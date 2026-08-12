import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';
import type { TranscriptSegment } from '../../src/utils/transcript.js';

vi.mock('../../src/utils/youtube.js', () => ({
  getTranscript: vi.fn(),
  getChapters: vi.fn(),
}));

import { getTranscript, getChapters } from '../../src/utils/youtube.js';
import { getTranscriptHandler } from '../../src/tools/get-transcript.js';
import { YouTubeError } from '../../src/utils/errors.js';

const SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 10, text: 'intro to the topic' },
  { start: 10, end: 20, text: 'the main argument' },
  { start: 20, end: 30, text: 'a closing thought' },
];

function args(
  overrides: Partial<Parameters<typeof getTranscriptHandler>[0]> = {}
): Parameters<typeof getTranscriptHandler>[0] {
  return {
    video: 'dQw4w9WgXcQ',
    language: 'en',
    format: 'text' as const,
    offset: 0,
    refresh: false,
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<YouTubeError> {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(YouTubeError);
  if (!(error instanceof YouTubeError)) throw new Error('expected a YouTubeError');
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTranscript).mockResolvedValue({
    transcript: 'intro to the topic the main argument a closing thought',
    segments: SEGMENTS,
    language: 'en',
    videoId: 'dQw4w9WgXcQ',
    cached: false,
  });
  vi.mocked(getChapters).mockResolvedValue([
    {
      title: 'Introduction',
      startTime: 0,
      endTime: 10,
      startTimeFormatted: '0:00',
      endTimeFormatted: '0:10',
    },
    {
      title: 'The Argument',
      startTime: 10,
      endTime: 30,
      startTimeFormatted: '0:10',
      endTimeFormatted: '0:30',
    },
  ]);
});

describe('getTranscriptHandler', () => {
  describe('formats', () => {
    it('returns flat text by default', async () => {
      const result = await getTranscriptHandler(args());

      expect(structuredOf(result)).toMatchObject({
        text: 'intro to the topic the main argument a closing thought',
        wordCount: 10,
        videoId: 'dQw4w9WgXcQ',
        language: 'en',
      });
    });

    it('prefixes each line with a start time when timestamped', async () => {
      const result = await getTranscriptHandler(args({ format: 'timestamped' }));

      expect(textOf(result)).toContain('[0:10] the main argument');
    });

    it('shows a start and end per line, plus the video link, when segments', async () => {
      const result = await getTranscriptHandler(args({ format: 'segments' }));
      const text = textOf(result);

      expect(text).toContain('[0:10 → 0:20] the main argument');
      expect(text).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('always returns the segments in structured output, whatever the text format', async () => {
      const result = await getTranscriptHandler(args({ format: 'text' }));

      expect(structuredOf(result)).toMatchObject({
        segments: [
          { startSeconds: 0, endSeconds: 10, text: 'intro to the topic' },
          { startSeconds: 10, endSeconds: 20, text: 'the main argument' },
          { startSeconds: 20, endSeconds: 30, text: 'a closing thought' },
        ],
      });
    });
  });

  describe('slicing by time', () => {
    it('returns only the segments in range', async () => {
      const result = await getTranscriptHandler(args({ startTime: '0:10', endTime: '0:20' }));

      expect(structuredOf(result)).toMatchObject({ text: 'the main argument' });
    });

    it('accepts a bare number of seconds', async () => {
      const result = await getTranscriptHandler(args({ startTime: '20' }));

      expect(structuredOf(result)).toMatchObject({ text: 'a closing thought' });
    });

    it('reports the range in the header', async () => {
      const result = await getTranscriptHandler(args({ startTime: '0:10', endTime: '0:20' }));

      expect(textOf(result)).toContain('Range: 0:10 – 0:20');
    });

    it('rejects an inverted range without fetching anything', async () => {
      const error = await caught(
        getTranscriptHandler(args({ startTime: '0:30', endTime: '0:10' }))
      );

      expect(error.code).toBe('INVALID_INPUT');
      expect(getTranscript).not.toHaveBeenCalled();
    });

    it('says what the transcript actually covers when the range is empty', async () => {
      const error = await caught(getTranscriptHandler(args({ startTime: '10:00' })));

      expect(error.code).toBe('NOT_FOUND');
      expect(error.toToolMessage()).toContain('0:30');
    });
  });

  describe('slicing by chapter', () => {
    it('resolves a chapter name to its range', async () => {
      const result = await getTranscriptHandler(args({ chapter: 'The Argument' }));

      expect(structuredOf(result)).toMatchObject({
        chapter: 'The Argument',
        text: 'the main argument a closing thought',
      });
    });

    it('matches a chapter name case-insensitively', async () => {
      const result = await getTranscriptHandler(args({ chapter: 'the argument' }));

      expect(structuredOf(result)).toMatchObject({ chapter: 'The Argument' });
    });

    it('matches on a substring when nothing matches exactly', async () => {
      const result = await getTranscriptHandler(args({ chapter: 'Argu' }));

      expect(structuredOf(result)).toMatchObject({ chapter: 'The Argument' });
    });

    it('prefers an exact match over a substring one', async () => {
      vi.mocked(getChapters).mockResolvedValue([
        {
          title: 'Intro extended',
          startTime: 0,
          endTime: 10,
          startTimeFormatted: '0:00',
          endTimeFormatted: '0:10',
        },
        {
          title: 'Intro',
          startTime: 10,
          endTime: 30,
          startTimeFormatted: '0:10',
          endTimeFormatted: '0:30',
        },
      ]);

      const result = await getTranscriptHandler(args({ chapter: 'Intro' }));

      expect(structuredOf(result)).toMatchObject({ chapter: 'Intro' });
    });

    it('lists the available chapters when the name does not match', async () => {
      const error = await caught(getTranscriptHandler(args({ chapter: 'Nonexistent' })));

      expect(error.code).toBe('NOT_FOUND');
      expect(error.toToolMessage()).toContain('Introduction, The Argument');
    });

    it('points at startTime/endTime when the video has no chapters', async () => {
      vi.mocked(getChapters).mockResolvedValue([]);

      const error = await caught(getTranscriptHandler(args({ chapter: 'Anything' })));

      expect(error.code).toBe('NOT_FOUND');
      expect(error.toToolMessage()).toContain('startTime');
    });

    it('refuses a chapter and an explicit range together', async () => {
      const error = await caught(
        getTranscriptHandler(args({ chapter: 'Intro', startTime: '0:05' }))
      );

      expect(error.code).toBe('INVALID_INPUT');
      expect(getTranscript).not.toHaveBeenCalled();
    });
  });

  describe('windowing', () => {
    it('returns everything and reports no truncation when uncapped', async () => {
      const result = await getTranscriptHandler(args());

      expect(structuredOf(result)).toMatchObject({ truncated: false });
      expect(structuredOf(result).nextOffset).toBeUndefined();
    });

    it('caps the output and hands back the offset to continue from', async () => {
      const result = await getTranscriptHandler(args({ maxChars: 20 }));
      const structured = structuredOf(result);

      expect(structured).toMatchObject({ truncated: true });
      expect(structured.nextOffset).toBeGreaterThan(0);
    });

    it('tells the caller how to fetch the rest', async () => {
      const result = await getTranscriptHandler(args({ maxChars: 20 }));

      expect(textOf(result)).toContain('Call again with offset=');
    });

    it('resumes from an offset', async () => {
      const first = structuredOf(await getTranscriptHandler(args({ maxChars: 20 })));
      const second = structuredOf(
        await getTranscriptHandler(args({ maxChars: 20, offset: Number(first.nextOffset) }))
      );

      expect(second.text).not.toBe(first.text);
    });

    it('counts words over the whole slice, not just the visible window', async () => {
      const capped = structuredOf(await getTranscriptHandler(args({ maxChars: 20 })));
      const whole = structuredOf(await getTranscriptHandler(args()));

      // Otherwise a paginated read would report a shrinking transcript.
      expect(capped.wordCount).toBe(whole.wordCount);
    });
  });

  it('passes refresh through so a stale cache can be bypassed', async () => {
    await getTranscriptHandler(args({ refresh: true }));

    expect(getTranscript).toHaveBeenCalledWith('dQw4w9WgXcQ', { language: 'en', refresh: true });
  });

  it('reports whether the answer came from cache', async () => {
    vi.mocked(getTranscript).mockResolvedValue({
      transcript: 'cached text',
      segments: SEGMENTS,
      language: 'en',
      videoId: 'dQw4w9WgXcQ',
      cached: true,
    });

    expect(structuredOf(await getTranscriptHandler(args()))).toMatchObject({ cached: true });
  });
});
