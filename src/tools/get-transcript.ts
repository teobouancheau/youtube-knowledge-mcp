import { z } from 'zod';
import { getChapters, getTranscript } from '../utils/youtube.js';
import { toolResult } from '../utils/format.js';
import { transcriptSegmentSchema } from '../schemas.js';
import { YouTubeError } from '../utils/errors.js';
import { parseTimestamp } from '../utils/validate.js';
import {
  formatTimestamp,
  segmentsToText,
  segmentsToTimestamped,
  sliceSegments,
  windowText,
  type TranscriptSegment,
} from '../utils/transcript.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const getTranscriptSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
  language: z
    .string()
    .default('en')
    .describe(
      'Preferred caption language as ISO 639-1 code (e.g., en, fr, es, de). Falls back to available language if unavailable. Default: en'
    ),
  format: z
    .enum(['text', 'timestamped', 'segments'])
    .default('text')
    .describe(
      'Output shape. "text" is one continuous block. "timestamped" prefixes each line with [MM:SS] — use this when you need to cite or link to specific moments. "segments" returns individual cues. Default: text'
    ),
  startTime: z
    .string()
    .optional()
    .describe('Only return content from this point on. Seconds, MM:SS or HH:MM:SS.'),
  endTime: z
    .string()
    .optional()
    .describe('Only return content up to this point. Seconds, MM:SS or HH:MM:SS.'),
  chapter: z
    .string()
    .optional()
    .describe(
      'Only return this chapter, matched case-insensitively against chapter titles. Cannot be combined with startTime/endTime.'
    ),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(500_000)
    .optional()
    .describe(
      'Cap the returned characters. A long video can exceed 100,000 tokens; use this with offset to read it in pieces.'
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Character offset to resume from, as reported by a previous truncated call.'),
  refresh: z
    .boolean()
    .default(false)
    .describe('Bypass the local cache and refetch from YouTube. Default: false'),
};

export const getTranscriptOutputSchema = {
  videoId: z.string(),
  language: z.string(),
  text: z.string(),
  segments: z.array(transcriptSegmentSchema),
  wordCount: z.number().int(),
  chapter: z.string().optional(),
  truncated: z.boolean(),
  nextOffset: z.number().int().optional(),
  totalChars: z.number().int(),
  cached: z.boolean(),
};

export interface GetTranscriptArgs {
  video: string;
  language: string;
  format: 'text' | 'timestamped' | 'segments';
  startTime?: string;
  endTime?: string;
  chapter?: string;
  maxChars?: number;
  offset: number;
  refresh: boolean;
}

/** Resolve a chapter name to a time range using the video's own chapter markers. */
async function resolveChapterRange(
  video: string,
  chapter: string
): Promise<{ startTime: number; endTime: number; title: string }> {
  const chapters = await getChapters(video);

  if (chapters.length === 0) {
    throw new YouTubeError('NOT_FOUND', 'This video has no chapters.', {
      nextStep: 'Use startTime and endTime instead, or omit both to read the whole transcript.',
    });
  }

  const wanted = chapter.toLowerCase();
  const match =
    chapters.find((c) => c.title.toLowerCase() === wanted) ??
    chapters.find((c) => c.title.toLowerCase().includes(wanted));

  if (!match) {
    throw new YouTubeError('NOT_FOUND', `No chapter matches "${chapter}".`, {
      nextStep: `Available chapters: ${chapters.map((c) => c.title).join(', ')}`,
    });
  }

  return { startTime: match.startTime, endTime: match.endTime, title: match.title };
}

function renderSegments(segments: TranscriptSegment[], videoId: string): string {
  return segments
    .map(
      (segment) =>
        `[${formatTimestamp(segment.start)} → ${formatTimestamp(segment.end)}] ${segment.text}`
    )
    .join('\n')
    .concat(segments.length > 0 ? `\n\nVideo: https://www.youtube.com/watch?v=${videoId}` : '');
}

export async function getTranscriptHandler(args: GetTranscriptArgs): Promise<CallToolResult> {
  const { video, language, format, chapter, maxChars, offset, refresh } = args;

  if (chapter !== undefined && (args.startTime !== undefined || args.endTime !== undefined)) {
    throw new YouTubeError(
      'INVALID_INPUT',
      'Provide either chapter or startTime/endTime, not both.',
      {
        nextStep: 'Drop one of them and call again.',
      }
    );
  }

  const result = await getTranscript(video, { language, refresh });

  const resolvedChapter =
    chapter === undefined ? undefined : await resolveChapterRange(video, chapter);
  const chapterTitle = resolvedChapter?.title;

  const range: { startTime?: number; endTime?: number } = resolvedChapter
    ? { startTime: resolvedChapter.startTime, endTime: resolvedChapter.endTime }
    : {
        startTime:
          args.startTime === undefined ? undefined : parseTimestamp(args.startTime, 'startTime'),
        endTime: args.endTime === undefined ? undefined : parseTimestamp(args.endTime, 'endTime'),
      };

  if (
    range.startTime !== undefined &&
    range.endTime !== undefined &&
    range.startTime >= range.endTime
  ) {
    throw new YouTubeError('INVALID_INPUT', 'startTime must be earlier than endTime.');
  }

  const sliced =
    range.startTime === undefined && range.endTime === undefined
      ? result.segments
      : sliceSegments(result.segments, range);

  if (sliced.length === 0) {
    throw new YouTubeError('NOT_FOUND', 'No transcript content falls in that range.', {
      nextStep: `The transcript covers 0:00 to ${formatTimestamp(result.segments.at(-1)?.end ?? 0)}.`,
    });
  }

  const body =
    format === 'text'
      ? segmentsToText(sliced)
      : format === 'timestamped'
        ? segmentsToTimestamped(sliced)
        : renderSegments(sliced, result.videoId);

  const windowed = windowText(body, offset, maxChars);
  const wordCount = segmentsToText(sliced).split(/\s+/).filter(Boolean).length;

  const header = [
    `Transcript (${result.language})`,
    chapterTitle !== undefined ? `Chapter: ${chapterTitle}` : undefined,
    range.startTime !== undefined || range.endTime !== undefined
      ? `Range: ${formatTimestamp(range.startTime ?? 0)} – ${formatTimestamp(range.endTime ?? sliced.at(-1)?.end ?? 0)}`
      : undefined,
    `${wordCount.toLocaleString()} words`,
    windowed.truncated
      ? `Showing characters ${offset.toLocaleString()}–${(windowed.nextOffset ?? 0).toLocaleString()} of ${windowed.totalChars.toLocaleString()}. Call again with offset=${String(windowed.nextOffset)} for the next part.`
      : undefined,
  ].filter((line): line is string => line !== undefined);

  return toolResult([...header, '', windowed.text].join('\n'), {
    videoId: result.videoId,
    language: result.language,
    text: windowed.text,
    segments: sliced.map((segment) => ({
      startSeconds: segment.start,
      endSeconds: segment.end,
      text: segment.text,
    })),
    wordCount,
    ...(chapterTitle === undefined ? {} : { chapter: chapterTitle }),
    truncated: windowed.truncated,
    ...(windowed.nextOffset === undefined ? {} : { nextOffset: windowed.nextOffset }),
    totalChars: windowed.totalChars,
    cached: result.cached,
  });
}
