import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fileResult, formatFilesize } from '../utils/format.js';
import { DEFAULT_GIF_FPS, DEFAULT_GIF_WIDTH, extractGif } from '../utils/gif.js';
import { MAX_CONCAT_FILES, MIN_CONCAT_FILES, concatClips } from '../utils/concat.js';
import { formatTimestamp } from '../utils/transcript.js';
import { RANGE_FIELDS, parseRange } from './clips.js';

/** Small pieces of video editing: an animated GIF from a moment, and clips joined into one. */

// -- extract_gif ---------------------------------------------------------

export const extractGifSchema = {
  video: z.string().describe('YouTube video ID or full URL'),
  ...RANGE_FIELDS,
  width: z
    .number()
    .int()
    .min(120)
    .max(800)
    .default(DEFAULT_GIF_WIDTH)
    .describe(`GIF width in pixels. Default: ${String(DEFAULT_GIF_WIDTH)}`),
  fps: z
    .number()
    .int()
    .min(4)
    .max(24)
    .default(DEFAULT_GIF_FPS)
    .describe(`Frames per second. Default: ${String(DEFAULT_GIF_FPS)}`),
};

export const extractGifOutputSchema = {
  videoId: z.string(),
  title: z.string(),
  filePath: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  durationSeconds: z.number(),
  width: z.number().int(),
  fps: z.number().int(),
  bytes: z.number().int(),
};

export interface ExtractGifArgs {
  video: string;
  start?: string;
  end?: string;
  chapter?: string;
  outputDir?: string;
  width: number;
  fps: number;
}

export async function extractGifHandler(args: ExtractGifArgs): Promise<CallToolResult> {
  const result = await extractGif(args.video, parseRange(args), {
    width: args.width,
    fps: args.fps,
    outputDir: args.outputDir,
  });

  return fileResult(
    [
      '✓ GIF made',
      '',
      result.title,
      `${formatTimestamp(result.start)} – ${formatTimestamp(result.end)}, ${String(result.width)}px at ${String(result.fps)} fps, ${formatFilesize(result.bytes)}`,
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
      width: result.width,
      fps: result.fps,
      bytes: result.bytes,
    },
    { path: result.filePath, name: `${result.title} GIF`, mimeType: 'image/gif' }
  );
}

// -- concat_clips --------------------------------------------------------

export const concatClipsSchema = {
  clips: z
    .array(z.string().max(1024))
    .min(MIN_CONCAT_FILES)
    .max(MAX_CONCAT_FILES)
    .describe(
      `Paths of the video files to join, in order, each inside your home directory. Between ${String(MIN_CONCAT_FILES)} and ${String(MAX_CONCAT_FILES)}. Typically the paths extract_clip returned.`
    ),
  name: z
    .string()
    .max(80)
    .optional()
    .describe('Name for the joined file, without extension. Default: montage-<hash of the inputs>'),
  outputDir: z
    .string()
    .optional()
    .describe('Where to write the file. Must be inside your home directory.'),
};

export const concatClipsOutputSchema = {
  filePath: z.string(),
  clips: z.number().int(),
  bytes: z.number().int(),
};

export async function concatClipsHandler(args: {
  clips: string[];
  name?: string;
  outputDir?: string;
}): Promise<CallToolResult> {
  const { clips, name, outputDir } = args;
  const result = await concatClips(clips, { name, outputDir });

  return fileResult(
    [
      `✓ ${String(result.clips)} clips joined`,
      '',
      formatFilesize(result.bytes),
      '',
      result.filePath,
    ].join('\n'),
    { filePath: result.filePath, clips: result.clips, bytes: result.bytes },
    { path: result.filePath, name: 'Joined clips', mimeType: 'video/mp4' }
  );
}
