import { z } from 'zod';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileResult } from '../utils/format.js';
import { parseTimestamp, resolveOutputDir } from '../utils/validate.js';
import { extractFrame, safeStem, subtitlesDir } from '../utils/clips.js';
import { getTranscript } from '../utils/youtube.js';
import { formatTimestamp, segmentsToText, toSrt, toVtt } from '../utils/transcript.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Stills and subtitles: the two extraction tools that produce something other
 * than a media clip. Split from clips.ts only for size.
 */

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

export const extractFrameOutputSchema = {
  videoId: z.string(),
  title: z.string(),
  filePath: z.string(),
  timestampSeconds: z.number(),
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

  return fileResult(
    [
      '✓ Frame captured',
      '',
      result.title,
      `at ${formatTimestamp(result.timestamp)}`,
      '',
      result.filePath,
    ].join('\n'),
    {
      videoId: result.videoId,
      title: result.title,
      filePath: result.filePath,
      timestampSeconds: result.timestamp,
    },
    {
      path: result.filePath,
      name: `${result.title} frame`,
      mimeType: args.format === 'png' ? 'image/png' : 'image/jpeg',
    }
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

export const exportSubtitlesOutputSchema = {
  videoId: z.string(),
  language: z.string(),
  format: z.enum(['srt', 'vtt', 'txt']),
  filePath: z.string(),
  cueCount: z.number().int(),
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

  return fileResult(
    [
      `✓ Subtitles exported (${args.format.toUpperCase()})`,
      '',
      `${transcript.segments.length.toLocaleString()} cues · ${transcript.language}`,
      '',
      filePath,
    ].join('\n'),
    {
      videoId: transcript.videoId,
      language: transcript.language,
      format: args.format,
      filePath,
      cueCount: transcript.segments.length,
    },
    {
      path: filePath,
      name: `${transcript.videoId}.${args.format}`,
      mimeType: args.format === 'txt' ? 'text/plain' : `text/${args.format}`,
    }
  );
}
