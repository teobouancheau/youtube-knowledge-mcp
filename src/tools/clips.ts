import { z } from 'zod';
import { fileResult, toolResult } from '../utils/format.js';
import { clipResultSchema } from '../schemas.js';
import { parseTimestamp } from '../utils/validate.js';
import { extractClip } from '../utils/clips.js';
import { QUALITY_FORMAT_SELECTORS, type VideoQuality } from '../utils/youtube.js';
import { inBatches } from '../utils/batches.js';
import { concurrencyState } from '../utils/ytdlp.js';
import { formatTimestamp } from '../utils/transcript.js';
import { asYouTubeError } from '../utils/errors.js';
import { reportProgress, throwIfAborted } from '../utils/context.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Editing workflows: pull excerpts out rather than downloading whole videos.
 *
 * These pair with search_transcript — find the moment by phrase, then cut the
 * clip around it — which is the whole point of keeping cue timings.
 */

const QUALITY = z
  .enum(['best', '2160p', '1440p', '1080p', '720p', '480p', '360p'])
  .default('1080p')
  .describe('Maximum resolution to fetch. Default: 1080p');

const RANGE_FIELDS = {
  start: z
    .string()
    .optional()
    .describe('Clip start. Seconds, MM:SS or HH:MM:SS. Required unless chapter is given.'),
  end: z
    .string()
    .optional()
    .describe('Clip end. Seconds, MM:SS or HH:MM:SS. Required unless chapter is given.'),
  chapter: z
    .string()
    .optional()
    .describe('Use this chapter as the range instead of start/end, matched case-insensitively.'),
  outputDir: z
    .string()
    .optional()
    .describe('Where to write the file. Must be inside your home directory.'),
};

/**
 * The one format-selector table, shared with download_video. A second copy
 * lived here with shorter fallback chains, so a clip could fail on a video the
 * same quality preset downloaded fine.
 */
function clipSelector(quality: string): string {
  const known = (Object.keys(QUALITY_FORMAT_SELECTORS) as VideoQuality[]).find(
    (key) => key === quality
  );
  return QUALITY_FORMAT_SELECTORS[known ?? '1080p'];
}

function parseRange(args: { start?: string; end?: string; chapter?: string }): {
  start?: number;
  end?: number;
  chapter?: string;
} {
  return {
    start: args.start === undefined ? undefined : parseTimestamp(args.start, 'start'),
    end: args.end === undefined ? undefined : parseTimestamp(args.end, 'end'),
    chapter: args.chapter,
  };
}

// -- extract_clip --------------------------------------------------------

export const extractClipSchema = {
  video: z.string().describe('YouTube video ID or full URL'),
  ...RANGE_FIELDS,
  quality: QUALITY,
  preciseCuts: z
    .boolean()
    .default(true)
    .describe(
      'Cut exactly at the requested times. Set false for a faster keyframe-aligned cut that may be a second or two off. Default: true'
    ),
};

export const extractClipOutputSchema = clipResultSchema.shape;

export interface ExtractClipArgs {
  video: string;
  start?: string;
  end?: string;
  chapter?: string;
  outputDir?: string;
  quality: string;
  preciseCuts: boolean;
}

export async function extractClipHandler(args: ExtractClipArgs): Promise<CallToolResult> {
  const result = await extractClip(args.video, parseRange(args), {
    formatSelector: clipSelector(args.quality),
    outputDir: args.outputDir,
    preciseCuts: args.preciseCuts,
    container: 'mp4',
  });

  return fileResult(
    [
      '✓ Clip extracted',
      '',
      result.title,
      `${formatTimestamp(result.start)} – ${formatTimestamp(result.end)} (${Math.round(result.duration)}s)`,
      '',
      result.filePath,
    ].join('\n'),
    {
      videoId: result.videoId,
      title: result.title,
      filePath: result.filePath,
      startSeconds: result.start,
      endSeconds: result.end,
      durationSeconds: result.duration,
    },
    { path: result.filePath, name: `${result.title} clip`, mimeType: 'video/mp4' }
  );
}

// -- extract_audio_clip --------------------------------------------------

export const extractAudioClipSchema = {
  video: z.string().describe('YouTube video ID or full URL'),
  ...RANGE_FIELDS,
  audioFormat: z
    .enum(['mp3', 'm4a', 'wav', 'flac', 'opus'])
    .default('mp3')
    .describe('Output container. Use wav for editing, mp3 for sharing. Default: mp3'),
};

export const extractAudioClipOutputSchema = clipResultSchema.shape;

export interface ExtractAudioClipArgs {
  video: string;
  start?: string;
  end?: string;
  chapter?: string;
  outputDir?: string;
  audioFormat: 'mp3' | 'm4a' | 'wav' | 'flac' | 'opus';
}

export async function extractAudioClipHandler(args: ExtractAudioClipArgs): Promise<CallToolResult> {
  const result = await extractClip(args.video, parseRange(args), {
    formatSelector: 'bestaudio/best',
    outputDir: args.outputDir,
    preciseCuts: true,
    container: args.audioFormat,
    audioOnly: true,
    audioFormat: args.audioFormat,
  });

  return fileResult(
    [
      '✓ Audio clip extracted',
      '',
      result.title,
      `${formatTimestamp(result.start)} – ${formatTimestamp(result.end)} (${Math.round(result.duration)}s, ${args.audioFormat})`,
      '',
      result.filePath,
    ].join('\n'),
    {
      videoId: result.videoId,
      title: result.title,
      filePath: result.filePath,
      startSeconds: result.start,
      endSeconds: result.end,
      durationSeconds: result.duration,
    },
    { path: result.filePath, name: `${result.title} audio`, mimeType: `audio/${args.audioFormat}` }
  );
}

// -- extract_clips (batch) -----------------------------------------------

export const extractClipsSchema = {
  video: z.string().describe('YouTube video ID or full URL'),
  ranges: z
    .array(
      z.object({
        start: z.string().describe('Clip start. Seconds, MM:SS or HH:MM:SS.'),
        end: z.string().describe('Clip end. Seconds, MM:SS or HH:MM:SS.'),
      })
    )
    .min(1)
    .max(20)
    .describe('Time ranges to cut from the same video'),
  quality: QUALITY,
  preciseCuts: z
    .boolean()
    .default(true)
    .describe('Cut exactly at the requested times. Default: true'),
  outputDir: z
    .string()
    .optional()
    .describe('Where to write the files. Must be inside your home directory.'),
};

export const extractClipsOutputSchema = {
  clips: z.array(clipResultSchema),
  failures: z.array(z.object({ start: z.string(), end: z.string(), error: z.string() })),
  requested: z.number().int(),
  succeeded: z.number().int(),
};

export interface ExtractClipsArgs {
  video: string;
  ranges: { start: string; end: string }[];
  quality: string;
  preciseCuts: boolean;
  outputDir?: string;
}

type ClipOutcome =
  | { ok: true; line: string; clip: Record<string, unknown> }
  | { ok: false; line: string; failure: { start: string; end: string; error: string } };

/**
 * Several ranges from one video, cut as many at a time as the yt-dlp limiter
 * allows. Twenty clips used to run one after another while the limiter sat
 * idle; the results still come back in the order the ranges were given.
 */
export async function extractClipsHandler(args: ExtractClipsArgs): Promise<CallToolResult> {
  let done = 0;

  const outcomes = await inBatches(
    args.ranges,
    concurrencyState().limit,
    async (range): Promise<ClipOutcome> => {
      throwIfAborted();
      try {
        const result = await extractClip(args.video, parseRange(range), {
          formatSelector: clipSelector(args.quality),
          outputDir: args.outputDir,
          preciseCuts: args.preciseCuts,
          container: 'mp4',
        });
        return {
          ok: true,
          line: `✓ ${formatTimestamp(result.start)}–${formatTimestamp(result.end)}  ${result.filePath}`,
          clip: {
            videoId: result.videoId,
            title: result.title,
            filePath: result.filePath,
            startSeconds: result.start,
            endSeconds: result.end,
            durationSeconds: result.duration,
          },
        };
      } catch (error) {
        // One bad range should not discard the clips that did cut.
        const failure = asYouTubeError(error);
        return {
          ok: false,
          line: `✗ ${range.start}–${range.end}  [${failure.code}] ${failure.message}`,
          failure: { start: range.start, end: range.end, error: failure.code },
        };
      } finally {
        done++;
        reportProgress(done, args.ranges.length, `Cut ${done} of ${args.ranges.length} clips`);
      }
    }
  );

  const clips = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.clip] : []));
  const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.failure]));

  return toolResult(
    [
      `${clips.length} of ${args.ranges.length} clips extracted`,
      '',
      ...outcomes.map((outcome) => outcome.line),
    ].join('\n'),
    { clips, failures, requested: args.ranges.length, succeeded: clips.length }
  );
}
