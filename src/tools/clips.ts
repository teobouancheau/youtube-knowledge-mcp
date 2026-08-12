import { z } from 'zod';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { textContent } from '../utils/format.js';
import { parseTimestamp, resolveOutputDir } from '../utils/validate.js';
import { extractClip, extractFrame, safeStem, subtitlesDir } from '../utils/clips.js';
import { getTranscript } from '../utils/youtube.js';
import { formatTimestamp, segmentsToText, toSrt, toVtt } from '../utils/transcript.js';
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

const QUALITY_SELECTORS: Record<string, string> = {
  best: 'bestvideo*+bestaudio/best',
  '2160p': 'bestvideo[height<=2160]+bestaudio/best[height<=2160]/best',
  '1440p': 'bestvideo[height<=1440]+bestaudio/best[height<=1440]/best',
  '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
  '720p': 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
  '480p': 'bestvideo[height<=480]+bestaudio/best[height<=480]/best',
  '360p': 'bestvideo[height<=360]+bestaudio/best[height<=360]/best',
};

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
    formatSelector: QUALITY_SELECTORS[args.quality] ?? QUALITY_SELECTORS['1080p'] ?? 'best',
    outputDir: args.outputDir,
    preciseCuts: args.preciseCuts,
    container: 'mp4',
  });

  return textContent(
    [
      '✓ Clip extracted',
      '',
      result.title,
      `${formatTimestamp(result.start)} – ${formatTimestamp(result.end)} (${Math.round(result.duration)}s)`,
      '',
      result.filePath,
    ].join('\n')
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

  return textContent(
    [
      '✓ Audio clip extracted',
      '',
      result.title,
      `${formatTimestamp(result.start)} – ${formatTimestamp(result.end)} (${Math.round(result.duration)}s, ${args.audioFormat})`,
      '',
      result.filePath,
    ].join('\n')
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

export interface ExtractClipsArgs {
  video: string;
  ranges: { start: string; end: string }[];
  quality: string;
  preciseCuts: boolean;
  outputDir?: string;
}

export async function extractClipsHandler(args: ExtractClipsArgs): Promise<CallToolResult> {
  const lines: string[] = [];
  let succeeded = 0;

  for (const [index, range] of args.ranges.entries()) {
    throwIfAborted();
    reportProgress(index, args.ranges.length, `Cutting clip ${index + 1} of ${args.ranges.length}`);

    try {
      const result = await extractClip(
        args.video,
        parseRange({ start: range.start, end: range.end }),
        {
          formatSelector: QUALITY_SELECTORS[args.quality] ?? QUALITY_SELECTORS['1080p'] ?? 'best',
          outputDir: args.outputDir,
          preciseCuts: args.preciseCuts,
          container: 'mp4',
        }
      );
      lines.push(
        `✓ ${formatTimestamp(result.start)}–${formatTimestamp(result.end)}  ${result.filePath}`
      );
      succeeded++;
    } catch (error) {
      // One bad range should not discard the clips that did cut.
      const failure = asYouTubeError(error);
      lines.push(`✗ ${range.start}–${range.end}  [${failure.code}] ${failure.message}`);
    }
  }

  reportProgress(args.ranges.length, args.ranges.length);

  return textContent(
    [`${succeeded} of ${args.ranges.length} clips extracted`, '', ...lines].join('\n')
  );
}

// -- extract_frame -------------------------------------------------------

export const extractFrameSchema = {
  video: z.string().describe('YouTube video ID or full URL'),
  timestamp: z.string().describe('When to capture. Seconds, MM:SS or HH:MM:SS.'),
  format: z.enum(['png', 'jpg']).default('png').describe('Image format. Default: png'),
  outputDir: z
    .string()
    .optional()
    .describe('Where to write the image. Must be inside your home directory.'),
};

export async function extractFrameHandler(args: {
  video: string;
  timestamp: string;
  format: 'png' | 'jpg';
  outputDir?: string;
}): Promise<CallToolResult> {
  const seconds = parseTimestamp(args.timestamp, 'timestamp');
  const result = await extractFrame(args.video, seconds, {
    outputDir: args.outputDir,
    format: args.format,
  });

  return textContent(
    [
      '✓ Frame captured',
      '',
      result.title,
      `at ${formatTimestamp(result.timestamp)}`,
      '',
      result.filePath,
    ].join('\n')
  );
}

// -- export_subtitles ----------------------------------------------------

export const exportSubtitlesSchema = {
  video: z.string().describe('YouTube video ID or full URL'),
  format: z
    .enum(['srt', 'vtt', 'txt'])
    .default('srt')
    .describe(
      'Subtitle format. srt and vtt import into any editor; txt is plain text. Default: srt'
    ),
  language: z.string().default('en').describe('Caption language. Default: en'),
  outputDir: z
    .string()
    .optional()
    .describe('Where to write the file. Must be inside your home directory.'),
};

export async function exportSubtitlesHandler(args: {
  video: string;
  format: 'srt' | 'vtt' | 'txt';
  language: string;
  outputDir?: string;
}): Promise<CallToolResult> {
  // Validate the destination before spending a network round trip on a
  // transcript we would then have nowhere to write.
  const targetDir = resolveOutputDir(args.outputDir, subtitlesDir());

  const transcript = await getTranscript(args.video, { language: args.language });

  const body =
    args.format === 'srt'
      ? toSrt(transcript.segments)
      : args.format === 'vtt'
        ? toVtt(transcript.segments)
        : segmentsToText(transcript.segments);

  await mkdir(targetDir, { recursive: true });

  const filePath = join(
    targetDir,
    `${safeStem(transcript.videoId, transcript.videoId)}.${args.language}.${args.format}`
  );
  await writeFile(filePath, body, 'utf-8');

  return textContent(
    [
      `✓ Subtitles exported (${args.format.toUpperCase()})`,
      '',
      `${transcript.segments.length.toLocaleString()} cues · ${transcript.language}`,
      '',
      filePath,
    ].join('\n')
  );
}
