import webvtt from 'webvtt-parser';

/**
 * Timestamped transcripts.
 *
 * The previous parser threw every timestamp away and returned one flat string,
 * which made citation, slicing and clip extraction impossible: a model could
 * quote a three-hour video but never say *when* something was said. Cues are
 * now preserved, and everything downstream — deep links, chapter slicing,
 * subtitle export, clip cutting — is derived from them.
 */

export interface TranscriptSegment {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  text: string;
}

export type TranscriptFormat = 'text' | 'timestamped' | 'segments';

/** Bumped whenever the cache representation changes, so old files are refetched. */
export const TRANSCRIPT_CACHE_VERSION = 2;

export interface CachedTranscript {
  version: number;
  videoId: string;
  language: string;
  fetchedAt: string;
  segments: TranscriptSegment[];
}

/** 3723.5 -> "1:02:03", 62 -> "1:02" */
export function formatTimestamp(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;

  const paddedSeconds = seconds.toString().padStart(2, '0');
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${paddedSeconds}`;
  return `${minutes}:${paddedSeconds}`;
}

/** 3723.5 -> "01:02:03,500" — the SRT wire format. */
export function formatSrtTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);

  const pad = (value: number, width = 2): string => value.toString().padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/**
 * WebVTT cue text is a small markup language: inline timestamps and <c> spans
 * for karaoke-style highlighting. The parser hands back the spec's parsed tree,
 * so the readable text is a walk over its text nodes — no tag stripping, and no
 * pattern of our own to get wrong.
 */
function textOfCueNode(node: webvtt.TreeNode<webvtt.TreeNodeObjectTagNameWithRt>): string {
  // Exhaustive over the union the parser declares, so a new node kind becomes a
  // type error here rather than silently vanishing from the transcript.
  switch (node.type) {
    case 'text':
      return node.value;
    case 'timestamp':
      // Inline karaoke timing; carries no readable content.
      return '';
    case 'object':
      return node.children.map(textOfCueNode).join('');
  }
}

function textOfCueTree(tree: webvtt.Tree): string {
  return tree.children.map(textOfCueNode).join('');
}

/**
 * Parse WebVTT into segments.
 *
 * Parsing is delegated to the W3C reference implementation rather than matched
 * with our own expressions — WebVTT has a real grammar, and a hand-written
 * approximation of it is a source of silent wrong answers.
 *
 * The one thing left to us is YouTube-specific and not a parsing concern: its
 * auto-generated captions use a rolling window where each cue repeats the tail
 * of the previous one and appends a little more. Emitting every line would
 * duplicate most of the transcript, so a line repeating the one before it is
 * dropped — keeping the timing of its *first* appearance, which is what makes a
 * deep link land on the right moment.
 */
export function parseVtt(vttContent: string): TranscriptSegment[] {
  // Parse errors are reported rather than thrown: YouTube emits `Kind:` and
  // `Language:` headers that the spec does not define, and the parser flags
  // them while still returning every cue correctly.
  const { cues } = new webvtt.WebVTTParser().parse(vttContent, 'captions');

  const segments: TranscriptSegment[] = [];
  let lastLine = '';

  for (const cue of cues) {
    for (const line of textOfCueTree(cue.tree).split('\n')) {
      const text = line.trim();
      if (text === '' || text === lastLine) continue;

      const previous = segments.at(-1);
      if (previous?.start === cue.startTime) {
        // A multi-line cue is one moment, not several.
        previous.text = `${previous.text} ${text}`;
        previous.end = cue.endTime;
      } else {
        segments.push({ start: cue.startTime, end: cue.endTime, text });
      }

      lastLine = text;
    }
  }

  return segments;
}

export function segmentsToText(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => segment.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function segmentsToTimestamped(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`)
    .join('\n');
}

/** A URL that opens the video at this moment. */
export function deepLink(videoId: string, seconds: number): string {
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(seconds))}s`;
}

/** Segments overlapping [startTime, endTime]; either bound may be omitted. */
export function sliceSegments(
  segments: TranscriptSegment[],
  range: { startTime?: number; endTime?: number }
): TranscriptSegment[] {
  const from = range.startTime ?? Number.NEGATIVE_INFINITY;
  const to = range.endTime ?? Number.POSITIVE_INFINITY;

  // Overlap, not containment: a segment straddling the boundary is still
  // relevant to the range the caller asked about.
  return segments.filter((segment) => segment.end > from && segment.start < to);
}

export interface TranscriptMatch {
  segment: TranscriptSegment;
  /** The matched text, for highlighting. */
  match: string;
  url: string;
}

/**
 * Find a phrase or pattern in a transcript.
 *
 * Matching runs over the joined text of a small window of segments, not each
 * segment alone, so a phrase split across a caption boundary is still found —
 * which is most phrases, since caption breaks fall mid-sentence.
 */
export function searchSegments(
  segments: TranscriptSegment[],
  query: string,
  options: { regex?: boolean; caseSensitive?: boolean; limit?: number } = {}
): TranscriptMatch[] {
  const { regex = false, caseSensitive = false, limit = 20 } = options;

  const flags = caseSensitive ? 'g' : 'gi';
  const pattern = regex
    ? new RegExp(query, flags)
    : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);

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

export interface TruncationResult {
  text: string;
  truncated: boolean;
  /** Offset to pass back in to continue reading. */
  nextOffset?: number;
  totalChars: number;
}

/**
 * Window a long string.
 *
 * A three-hour transcript is well over 100k tokens and will blow out a client's
 * context if returned whole, so callers get a bounded slice plus the offset to
 * continue from.
 */
export function windowText(text: string, offset = 0, maxChars?: number): TruncationResult {
  const totalChars = text.length;
  const from = Math.min(Math.max(0, offset), totalChars);

  if (maxChars === undefined || from + maxChars >= totalChars) {
    return { text: text.slice(from), truncated: false, totalChars };
  }

  // Prefer to break on whitespace so a word is not split in half.
  const hardEnd = from + maxChars;
  const softEnd = text.lastIndexOf(' ', hardEnd);
  const end = softEnd > from ? softEnd : hardEnd;

  return { text: text.slice(from, end), truncated: true, nextOffset: end, totalChars };
}

export function toSrt(segments: TranscriptSegment[]): string {
  return (
    segments
      .map((segment, index) =>
        [
          index + 1,
          `${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(segment.end)}`,
          segment.text,
        ].join('\n')
      )
      .join('\n\n') + '\n'
  );
}

export function toVtt(segments: TranscriptSegment[]): string {
  const body = segments
    .map((segment) =>
      [
        `${formatSrtTimestamp(segment.start).replace(',', '.')} --> ${formatSrtTimestamp(segment.end).replace(',', '.')}`,
        segment.text,
      ].join('\n')
    )
    .join('\n\n');

  return `WEBVTT\n\n${body}\n`;
}
