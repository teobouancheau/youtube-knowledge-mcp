import type { BrainChunk } from '../brain-schemas.js';
import { segmentsToText, type TranscriptSegment } from './transcript.js';
import type { Chapter } from './youtube.js';

/**
 * Transcripts cut into retrievable passages.
 *
 * A brain is searched, not read: a whole transcript is too long to rank
 * usefully and far too long to return, while a single caption cue is too short
 * to carry a thought. A passage of a few sentences is what BM25 scores well and
 * what a reader can check against the video in one click.
 *
 * Chunks do not overlap. Overlap is worth its cost with embeddings, where a
 * concept split across a boundary can be missed entirely; BM25 matches terms,
 * and a duplicated passage would only mean two results saying the same thing.
 */

/** Where a passage stops being short enough to keep growing. */
export const CHUNK_TARGET_CHARS = 800;

/**
 * Where it stops regardless. Speech without a pause for this long is rare, and
 * an unbroken passage is worse than one broken in an awkward place.
 */
export const CHUNK_MAX_CHARS = 1200;

/** A pause this long is a sentence or a thought ending. */
export const CHUNK_BREAK_GAP_SECONDS = 2;

export interface ChunkTranscriptOptions {
  videoId: string;
  title: string;
  segments: TranscriptSegment[];
  /** Chapter starts are always passage boundaries: a new chapter is a new subject. */
  chapters?: Chapter[];
}

export function chunkTranscript(options: ChunkTranscriptOptions): BrainChunk[] {
  const { videoId, title, segments, chapters = [] } = options;

  const chapterStarts = chapters.map((chapter) => chapter.startTime).sort((a, b) => a - b);
  const chunks: BrainChunk[] = [];

  let current: TranscriptSegment[] = [];
  let currentChars = 0;
  let nextChapter = 0;

  const flush = (): void => {
    const chunk = toChunk(videoId, title, current, chunks.length);
    if (chunk !== undefined) chunks.push(chunk);
    current = [];
    currentChars = 0;
  };

  for (const segment of segments) {
    // Consume every chapter that starts at or before this segment. More than
    // one can land in the same gap when a chapter is shorter than a cue.
    let startsChapter = false;
    while (nextChapter < chapterStarts.length) {
      const start = chapterStarts[nextChapter];
      if (start === undefined || start > segment.start) break;
      nextChapter++;
      startsChapter = true;
    }

    const previous = current[current.length - 1];
    if (previous !== undefined && shouldBreak(previous, segment, currentChars, startsChapter)) {
      flush();
    }

    current.push(segment);
    // Plus one for the space this segment will be joined with.
    currentChars += segment.text.length + 1;
  }

  flush();
  return chunks;
}

function shouldBreak(
  previous: TranscriptSegment,
  segment: TranscriptSegment,
  currentChars: number,
  startsChapter: boolean
): boolean {
  if (startsChapter) return true;
  if (currentChars >= CHUNK_MAX_CHARS) return true;

  return (
    currentChars >= CHUNK_TARGET_CHARS && segment.start - previous.end >= CHUNK_BREAK_GAP_SECONDS
  );
}

/** Undefined for an empty run, and for one that turned out to be only whitespace. */
function toChunk(
  videoId: string,
  title: string,
  segments: TranscriptSegment[],
  ordinal: number
): BrainChunk | undefined {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first === undefined || last === undefined) return undefined;

  const text = segmentsToText(segments);
  if (text === '') return undefined;

  return {
    // Ordinal rather than start time: two passages can begin in the same second
    // when cues are short, and a colliding id would silently drop one of them
    // from the index. The start time is a field of its own.
    id: `${videoId}:${ordinal}`,
    videoId,
    title,
    startSeconds: first.start,
    endSeconds: last.end,
    text,
  };
}
