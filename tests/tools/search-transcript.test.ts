import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';
import type { TranscriptSegment } from '../../src/utils/transcript.js';

vi.mock('../../src/utils/youtube.js', () => ({
  getTranscript: vi.fn(),
}));

import { getTranscript } from '../../src/utils/youtube.js';
import { searchTranscriptHandler } from '../../src/tools/search-transcript.js';
import { YouTubeError } from '../../src/utils/errors.js';

const SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 10, text: 'welcome to the show' },
  { start: 10, end: 20, text: 'today we discuss rate limiting' },
  { start: 20, end: 30, text: 'and then we take questions' },
  { start: 30, end: 40, text: 'rate limiting comes up again' },
];

/** The full set of defaults the schema would have applied. */
function args(
  overrides: Partial<Parameters<typeof searchTranscriptHandler>[0]> = {}
): Parameters<typeof searchTranscriptHandler>[0] {
  return {
    video: 'dQw4w9WgXcQ',
    query: 'rate limiting',
    language: 'en',
    regex: false,
    caseSensitive: false,
    limit: 20,
    contextSeconds: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTranscript).mockResolvedValue({
    transcript: SEGMENTS.map((s) => s.text).join(' '),
    segments: SEGMENTS,
    language: 'en',
    videoId: 'dQw4w9WgXcQ',
    cached: false,
  });
});

describe('searchTranscriptHandler', () => {
  it('reports every match with its timestamp', async () => {
    const result = await searchTranscriptHandler(args());

    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      query: 'rate limiting',
      language: 'en',
      matchCount: 2,
      segmentsSearched: 4,
    });
  });

  it('gives each match a link that opens the video at that moment', async () => {
    const result = await searchTranscriptHandler(args());
    const text = textOf(result);

    // The whole point of the tool: a citation the caller can follow.
    expect(text).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s');
    expect(text).toContain('[0:10]');
  });

  it('pluralises the headline correctly for a single match', async () => {
    const result = await searchTranscriptHandler(args({ query: 'questions' }));

    expect(textOf(result)).toContain('1 match for "questions"');
    expect(textOf(result)).not.toContain('1 matches');
  });

  it('says what to try next when nothing matches', async () => {
    const result = await searchTranscriptHandler(args({ query: 'nonexistent phrase' }));

    expect(textOf(result)).toContain('No matches');
    expect(textOf(result)).toContain('get_transcript');
    expect(structuredOf(result)).toMatchObject({ matchCount: 0, segmentsSearched: 4 });
  });

  it('honours the limit', async () => {
    const result = await searchTranscriptHandler(args({ limit: 1 }));

    expect(structuredOf(result)).toMatchObject({ matchCount: 1 });
  });

  it('honours caseSensitive', async () => {
    const result = await searchTranscriptHandler(
      args({ query: 'RATE LIMITING', caseSensitive: true })
    );

    expect(structuredOf(result)).toMatchObject({ matchCount: 0 });
  });

  it('searches the requested language', async () => {
    await searchTranscriptHandler(args({ language: 'fr' }));

    expect(getTranscript).toHaveBeenCalledWith('dQw4w9WgXcQ', { language: 'fr' });
  });

  describe('contextSeconds', () => {
    it('includes surrounding segments when asked', async () => {
      const result = await searchTranscriptHandler(
        args({ query: 'questions', contextSeconds: 15 })
      );

      // The neighbouring lines, so the moment can be read in context.
      expect(textOf(result)).toContain('today we discuss rate limiting');
    });

    it('does not repeat the matched segment inside its own context', async () => {
      const result = await searchTranscriptHandler(
        args({ query: 'questions', contextSeconds: 15 })
      );
      const contextLine = textOf(result)
        .split('\n')
        .find((line) => line.trimStart().startsWith('…'));

      expect(contextLine).toBeDefined();
      expect(contextLine).not.toContain('and then we take questions');
    });

    it('adds no context line by default', async () => {
      const result = await searchTranscriptHandler(args({ query: 'questions' }));

      expect(textOf(result)).not.toContain('…');
    });

    it('leaves out a segment that falls outside the window', async () => {
      vi.mocked(getTranscript).mockResolvedValue({
        transcript: 'near far',
        segments: [
          { start: 0, end: 10, text: 'the needle is here' },
          { start: 11, end: 20, text: 'still nearby' },
          { start: 600, end: 610, text: 'much later in the video' },
        ],
        language: 'en',
        videoId: 'dQw4w9WgXcQ',
        cached: false,
      });

      const result = await searchTranscriptHandler(args({ query: 'needle', contextSeconds: 5 }));

      expect(textOf(result)).toContain('still nearby');
      expect(textOf(result)).not.toContain('much later in the video');
    });
  });

  describe('regex', () => {
    it('treats the query as a pattern when asked', async () => {
      const result = await searchTranscriptHandler(
        args({ query: 'rate\\s+limiting', regex: true })
      );

      expect(structuredOf(result)).toMatchObject({ matchCount: 2 });
    });

    it('treats the query literally by default', async () => {
      const result = await searchTranscriptHandler(args({ query: 'rate\\s+limiting' }));

      expect(structuredOf(result)).toMatchObject({ matchCount: 0 });
    });

    it('rejects an invalid pattern before fetching anything', async () => {
      const error: unknown = await searchTranscriptHandler(
        args({ query: '(unclosed', regex: true })
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(YouTubeError);
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
      // Failing before the network call is the point: a bad pattern is the
      // caller's mistake and costs nothing to detect.
      expect(getTranscript).not.toHaveBeenCalled();
    });

    it('suggests the literal search as the way out of a bad pattern', async () => {
      const error = (await searchTranscriptHandler(args({ query: '(', regex: true })).catch(
        (e: unknown) => e
      )) as YouTubeError;

      expect(error.toToolMessage()).toContain('regex=false');
    });
  });
});
