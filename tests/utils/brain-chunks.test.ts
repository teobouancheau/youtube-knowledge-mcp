import { describe, it, expect } from 'vitest';
import {
  CHUNK_BREAK_GAP_SECONDS,
  CHUNK_MAX_CHARS,
  CHUNK_TARGET_CHARS,
  chunkTranscript,
} from '../../src/utils/brain-chunks.js';
import { formatTimestamp, type TranscriptSegment } from '../../src/utils/transcript.js';
import type { Chapter } from '../../src/utils/youtube.js';

/** Consecutive segments, `seconds` apart, each carrying `text`. */
function segments(count: number, text: string, seconds = 5): TranscriptSegment[] {
  return Array.from({ length: count }, (_unused, index) => ({
    start: index * seconds,
    end: index * seconds + seconds,
    text,
  }));
}

function chapter(title: string, startTime: number, endTime: number): Chapter {
  return {
    title,
    startTime,
    endTime,
    startTimeFormatted: formatTimestamp(startTime),
    endTimeFormatted: formatTimestamp(endTime),
  };
}

const VIDEO = { videoId: 'abc123', title: 'How to do the thing' };

describe('chunkTranscript', () => {
  it('returns nothing for a transcript with no segments', () => {
    expect(chunkTranscript({ ...VIDEO, segments: [] })).toEqual([]);
  });

  it('keeps a short transcript as a single passage', () => {
    const chunks = chunkTranscript({ ...VIDEO, segments: segments(3, 'a short line') });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('a short line a short line a short line');
    expect(chunks[0]?.startSeconds).toBe(0);
    expect(chunks[0]?.endSeconds).toBe(15);
  });

  it('breaks at a chapter start even mid-sentence', () => {
    const chunks = chunkTranscript({
      ...VIDEO,
      segments: segments(4, 'talking'),
      chapters: [chapter('Intro', 0, 10), chapter('The point', 10, 20)],
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.endSeconds).toBe(10);
    expect(chunks[1]?.startSeconds).toBe(10);
  });

  it('breaks on a long pause once the passage is long enough', () => {
    const line = 'x'.repeat(100);
    const before = segments(9, line);
    const last = before[before.length - 1];
    const after: TranscriptSegment[] = [
      {
        start: (last?.end ?? 0) + CHUNK_BREAK_GAP_SECONDS,
        end: (last?.end ?? 0) + CHUNK_BREAK_GAP_SECONDS + 5,
        text: line,
      },
    ];

    const chunks = chunkTranscript({ ...VIDEO, segments: [...before, ...after] });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text.length).toBeGreaterThanOrEqual(CHUNK_TARGET_CHARS);
  });

  it('ignores a long pause while the passage is still short', () => {
    const chunks = chunkTranscript({
      ...VIDEO,
      segments: [
        { start: 0, end: 2, text: 'first' },
        { start: 60, end: 62, text: 'second' },
      ],
    });

    expect(chunks).toHaveLength(1);
  });

  it('breaks unbroken speech at the hard ceiling', () => {
    const chunks = chunkTranscript({ ...VIDEO, segments: segments(40, 'y'.repeat(100), 1) });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS + 100);
    }
  });

  it('keeps one enormous segment rather than dropping it', () => {
    const chunks = chunkTranscript({
      ...VIDEO,
      segments: [{ start: 0, end: 600, text: 'z'.repeat(CHUNK_MAX_CHARS * 3) }],
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toHaveLength(CHUNK_MAX_CHARS * 3);
  });

  it('skips passages that are only whitespace', () => {
    const chunks = chunkTranscript({ ...VIDEO, segments: segments(3, '   ') });

    expect(chunks).toEqual([]);
  });

  it('gives every passage a distinct id, including within one second', () => {
    const chunks = chunkTranscript({
      ...VIDEO,
      segments: segments(30, 'w'.repeat(200), 0),
    });

    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
