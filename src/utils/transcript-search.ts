import type { TranscriptSegment } from './transcript.js';

/** Finding a phrase in a transcript. */

export interface TranscriptMatch {
  segment: TranscriptSegment;
  /** The matched text, for highlighting. */
  match: string;
  url: string;
}

/**
 * Find a compiled pattern in a transcript.
 *
 * Matching runs over the joined text of a small window of segments, not each
 * segment alone, so a phrase split across a caption boundary is still found —
 * which is most phrases, since caption breaks fall mid-sentence.
 *
 * The pattern arrives compiled (see `compilePattern`), so it was validated
 * exactly once, with the flags in force here.
 */
export function searchSegments(
  segments: TranscriptSegment[],
  pattern: RegExp,
  limit = 20
): TranscriptMatch[] {
  const matches: TranscriptMatch[] = [];

  for (let index = 0; index < segments.length && matches.length < limit; index++) {
    const current = segments[index];
    if (!current) continue;

    // Two segments of lookahead covers phrases spanning a caption break.
    const haystack = segments
      .slice(index, index + 3)
      .map((segment) => segment.text)
      .join(' ');

    pattern.lastIndex = 0;
    const found = pattern.exec(haystack);
    if (!found) continue;

    // The lookahead window means a hit can start in a *later* segment. Only
    // accept it here if it begins inside this one; otherwise the same hit is
    // reported once per preceding segment, and attributed to the wrong time.
    if (found.index > current.text.length) continue;

    matches.push({ segment: current, match: found[0], url: '' });
  }

  return matches;
}
