import { describe, it, expect } from 'vitest';
import {
  deepLink,
  formatSrtTimestamp,
  formatTimestamp,
  parseVtt,
  searchSegments,
  segmentsToText,
  segmentsToTimestamped,
  sliceSegments,
  toSrt,
  toVtt,
  windowText,
  type TranscriptSegment,
} from '../../src/utils/transcript.js';

/** A manual caption track: one cue per line, no rolling window. */
const MANUAL_VTT = `WEBVTT
Kind: captions
Language: en

1
00:00:00.000 --> 00:00:03.500
Welcome to the show.

2
00:00:03.500 --> 00:00:07.000
Today we discuss rate limiting.

3
00:01:02.000 --> 00:01:05.000
And that concludes the segment.
`;

/**
 * YouTube's auto-generated format: overlapping cues that repeat the previous
 * line and append a little more, with inline word timings.
 */
const AUTO_VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.000 align:start position:0%
hello<00:00:00.500><c> everyone</c>

00:00:02.000 --> 00:00:04.000 align:start position:0%
hello everyone
welcome<00:00:02.500><c> back</c>

00:00:04.000 --> 00:00:06.000 align:start position:0%
welcome back
to<00:00:04.500><c> the</c><00:00:04.800><c> show</c>
`;

describe('formatTimestamp', () => {
  it.each([
    [0, '0:00'],
    [62, '1:02'],
    [3723, '1:02:03'],
    [3600, '1:00:00'],
    [-5, '0:00'],
  ])('formats %d as %s', (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });
});

describe('formatSrtTimestamp', () => {
  it.each([
    [0, '00:00:00,000'],
    [62.5, '00:01:02,500'],
    [3723.25, '01:02:03,250'],
  ])('formats %d as %s', (seconds, expected) => {
    expect(formatSrtTimestamp(seconds)).toBe(expected);
  });
});

describe('parseVtt', () => {
  it('keeps the timing of every cue', () => {
    const segments = parseVtt(MANUAL_VTT);

    expect(segments).toEqual([
      { start: 0, end: 3.5, text: 'Welcome to the show.' },
      { start: 3.5, end: 7, text: 'Today we discuss rate limiting.' },
      { start: 62, end: 65, text: 'And that concludes the segment.' },
    ]);
  });

  it('drops the header, cue indices and blank lines', () => {
    const text = segmentsToText(parseVtt(MANUAL_VTT));

    expect(text).not.toContain('WEBVTT');
    expect(text).not.toContain('Kind:');
    expect(text).not.toMatch(/-->/);
    expect(text).not.toMatch(/^\d+$/m);
  });

  it('collapses the rolling window of auto-generated captions', () => {
    const segments = parseVtt(AUTO_VTT);

    // Each phrase appears once, not once per overlapping cue.
    expect(segmentsToText(segments)).toBe('hello everyone welcome back to the show');
  });

  it('anchors each phrase to when it was first said, so links land correctly', () => {
    const segments = parseVtt(AUTO_VTT);

    expect(segments[0]).toMatchObject({ start: 0, text: 'hello everyone' });
    expect(segments[1]).toMatchObject({ start: 2, text: 'welcome back' });
    expect(segments[2]).toMatchObject({ start: 4, text: 'to the show' });
  });

  it('strips inline word timings and colour spans', () => {
    expect(segmentsToText(parseVtt(AUTO_VTT))).not.toMatch(/<|>/);
  });

  it('handles CRLF line endings', () => {
    expect(parseVtt(MANUAL_VTT.replace(/\n/g, '\r\n'))).toHaveLength(3);
  });

  it('returns nothing for an empty or header-only file', () => {
    expect(parseVtt('')).toEqual([]);
    expect(parseVtt('WEBVTT\n\n')).toEqual([]);
  });

  it('ignores text appearing before any cue timing', () => {
    expect(parseVtt('WEBVTT\n\nstray text\n')).toEqual([]);
  });
});

const SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 10, text: 'intro to the topic' },
  { start: 10, end: 20, text: 'the main argument' },
  { start: 20, end: 30, text: 'a closing thought' },
];

describe('sliceSegments', () => {
  it('returns everything when no bounds are given', () => {
    expect(sliceSegments(SEGMENTS, {})).toHaveLength(3);
  });

  it('respects a start bound', () => {
    expect(sliceSegments(SEGMENTS, { startTime: 20 })).toEqual([SEGMENTS[2]]);
  });

  it('respects an end bound', () => {
    expect(sliceSegments(SEGMENTS, { endTime: 10 })).toEqual([SEGMENTS[0]]);
  });

  it('includes a segment straddling the boundary rather than dropping it', () => {
    // A sentence half inside the range is still relevant to that range.
    expect(sliceSegments(SEGMENTS, { startTime: 15, endTime: 25 })).toEqual([
      SEGMENTS[1],
      SEGMENTS[2],
    ]);
  });

  it('returns nothing for a range past the end', () => {
    expect(sliceSegments(SEGMENTS, { startTime: 100 })).toEqual([]);
  });
});

describe('segmentsToTimestamped', () => {
  it('prefixes each line with its start time', () => {
    expect(segmentsToTimestamped(SEGMENTS)).toBe(
      '[0:00] intro to the topic\n[0:10] the main argument\n[0:20] a closing thought'
    );
  });
});

describe('deepLink', () => {
  it('builds a URL that opens the video at the right second', () => {
    expect(deepLink('dQw4w9WgXcQ', 62.7)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=62s');
  });

  it('never emits a negative offset', () => {
    expect(deepLink('abc', -5)).toContain('t=0s');
  });
});

describe('searchSegments', () => {
  it('finds a literal phrase and reports the segment holding it', () => {
    const matches = searchSegments(SEGMENTS, 'main argument');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.segment.start).toBe(10);
  });

  it('is case-insensitive by default', () => {
    expect(searchSegments(SEGMENTS, 'MAIN ARGUMENT')).toHaveLength(1);
  });

  it('honours caseSensitive', () => {
    expect(searchSegments(SEGMENTS, 'MAIN ARGUMENT', { caseSensitive: true })).toHaveLength(0);
  });

  it('treats the query literally unless regex is set', () => {
    // Without escaping, "a." would match "a closing" as a regex.
    expect(searchSegments(SEGMENTS, 'a.')).toHaveLength(0);
    expect(searchSegments(SEGMENTS, 'a.', { regex: true }).length).toBeGreaterThan(0);
  });

  it('finds a phrase split across a caption boundary', () => {
    // Caption breaks fall mid-sentence, so this is the common case.
    const split: TranscriptSegment[] = [
      { start: 0, end: 2, text: 'we need to talk about' },
      { start: 2, end: 4, text: 'rate limiting today' },
    ];

    const matches = searchSegments(split, 'talk about rate limiting');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.segment.start).toBe(0);
  });

  it('does not report the same hit once per following segment', () => {
    const split: TranscriptSegment[] = [
      { start: 0, end: 2, text: 'alpha' },
      { start: 2, end: 4, text: 'beta' },
      { start: 4, end: 6, text: 'gamma' },
    ];

    expect(searchSegments(split, 'beta')).toHaveLength(1);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      start: i * 2,
      end: i * 2 + 2,
      text: 'repeated phrase',
    }));

    expect(searchSegments(many, 'repeated', { limit: 5 })).toHaveLength(5);
  });

  it('returns nothing when there is no match', () => {
    expect(searchSegments(SEGMENTS, 'nonexistent')).toEqual([]);
  });
});

describe('windowText', () => {
  const text = 'one two three four five six seven eight nine ten';

  it('returns everything when no cap is given', () => {
    expect(windowText(text)).toMatchObject({ text, truncated: false });
  });

  it('reports the total length', () => {
    expect(windowText(text).totalChars).toBe(text.length);
  });

  it('truncates and hands back the offset to continue from', () => {
    const result = windowText(text, 0, 12);

    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBeGreaterThan(0);
    expect(result.text.length).toBeLessThanOrEqual(12);
  });

  it('breaks on whitespace rather than mid-word', () => {
    const result = windowText(text, 0, 12);

    // A naive cut at 12 characters would yield "one two thre".
    expect(result.text).toBe('one two');
    expect(text.charAt(result.text.length)).toBe(' ');
  });

  it('resumes from an offset', () => {
    const first = windowText(text, 0, 12);
    const second = windowText(text, first.nextOffset ?? 0, 12);

    expect(second.text.trim()).not.toBe(first.text.trim());
  });

  it('reads to the end across successive windows', () => {
    let offset = 0;
    let assembled = '';

    for (let guard = 0; guard < 50; guard++) {
      const part = windowText(text, offset, 12);
      assembled += part.text;
      if (!part.truncated) break;
      offset = part.nextOffset ?? 0;
    }

    expect(assembled.replace(/\s+/g, ' ').trim()).toBe(text);
  });

  it('clamps an out-of-range offset', () => {
    expect(windowText(text, 9999, 10).text).toBe('');
  });
});

describe('subtitle export', () => {
  it('writes valid SRT with sequential indices', () => {
    const srt = toSrt(SEGMENTS);

    expect(srt).toContain('1\n00:00:00,000 --> 00:00:10,000\nintro to the topic');
    expect(srt).toContain('3\n00:00:20,000 --> 00:00:30,000\na closing thought');
  });

  it('writes valid WebVTT with the required header', () => {
    const vtt = toVtt(SEGMENTS);

    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> 00:00:10.000');
  });

  it('round-trips through the parser', () => {
    expect(parseVtt(toVtt(SEGMENTS))).toEqual(SEGMENTS);
  });
});
