import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { imageBlock } from '../utils/format.js';
import { parseOptionalTimestamp, parseTimestamp } from '../utils/validate.js';
import { DEFAULT_FRAME_WIDTH, MAX_FRAMES_PER_CALL, captureFrames } from '../utils/frames.js';
import {
  DEFAULT_SHEET_COLUMNS,
  MAX_SHEET_FRAMES,
  captureContactSheet,
} from '../utils/contact-sheet.js';
import { formatTimestamp } from '../utils/transcript.js';
import { videoMoment, videoMomentSchema } from '../utils/moment.js';

/**
 * Looking at a video: stills and contact sheets returned as images the model can
 * read, rather than files a person has to open.
 */

const JPEG_MIME = 'image/jpeg';
const DEFAULT_SHEET_FRAMES = 12;
const MAX_SHEET_COLUMNS = 8;

const WINDOW_FIELDS = {
  start: z.string().optional().describe('Window start. Seconds, MM:SS or HH:MM:SS. Default: 0.'),
  end: z
    .string()
    .optional()
    .describe('Window end. Seconds, MM:SS or HH:MM:SS. Default: the end of the video.'),
};

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

// -- extract_frames ------------------------------------------------------

export const extractFramesSchema = {
  video: z.string().describe('YouTube video ID or full URL'),
  timestamps: z
    .array(z.string())
    .max(MAX_FRAMES_PER_CALL)
    .optional()
    .describe(
      `Exact moments to look at, each as seconds, MM:SS or HH:MM:SS. Up to ${MAX_FRAMES_PER_CALL}. Use this after search_transcript or get_chapters.`
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_FRAMES_PER_CALL)
    .optional()
    .describe('Instead of timestamps: this many frames spread evenly across the window.'),
  ...WINDOW_FIELDS,
  width: z
    .number()
    .int()
    .min(160)
    .max(1280)
    .default(DEFAULT_FRAME_WIDTH)
    .describe(`Frame width in pixels, never enlarged. Default: ${DEFAULT_FRAME_WIDTH}`),
};

export const extractFramesOutputSchema = {
  videoId: z.string(),
  title: z.string(),
  width: z.number().int(),
  frames: z.array(videoMomentSchema).describe('One per image, in the order the images appear'),
};

export interface ExtractFramesArgs {
  video: string;
  timestamps?: string[];
  count?: number;
  start?: string;
  end?: string;
  width: number;
}

export async function extractFramesHandler(args: ExtractFramesArgs): Promise<CallToolResult> {
  const { video, count, width } = args;
  const timestamps = args.timestamps?.map((value) => parseTimestamp(value, 'timestamps'));

  const batch = await captureFrames(
    video,
    {
      timestamps,
      count,
      start: parseOptionalTimestamp(args.start, 'start'),
      end: parseOptionalTimestamp(args.end, 'end'),
    },
    { width, maxFrames: MAX_FRAMES_PER_CALL, label: 'Frame capture' }
  );

  const moments = batch.frames.map((frame) => videoMoment(batch.videoId, frame.timestamp));

  return {
    content: [
      textBlock(`${batch.title}: ${batch.frames.length} frames, ${width}px wide`),
      ...batch.frames.flatMap((frame) => [
        textBlock(`At ${formatTimestamp(frame.timestamp)}`),
        imageBlock(frame.bytes, JPEG_MIME),
      ]),
    ],
    structuredContent: { videoId: batch.videoId, title: batch.title, width, frames: moments },
  };
}

// -- contact_sheet -------------------------------------------------------

export const contactSheetSchema = {
  video: z.string().describe('YouTube video ID or full URL'),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_SHEET_FRAMES)
    .default(DEFAULT_SHEET_FRAMES)
    .describe(
      `How many frames to tile, spread evenly across the window. Up to ${MAX_SHEET_FRAMES}. Default: ${DEFAULT_SHEET_FRAMES}`
    ),
  ...WINDOW_FIELDS,
  columns: z
    .number()
    .int()
    .min(1)
    .max(MAX_SHEET_COLUMNS)
    .default(DEFAULT_SHEET_COLUMNS)
    .describe(`Cells per row. Default: ${DEFAULT_SHEET_COLUMNS}`),
};

export const contactSheetOutputSchema = {
  videoId: z.string(),
  title: z.string(),
  columns: z.number().int(),
  rows: z.number().int(),
  mimeType: z.string(),
  cells: z
    .array(videoMomentSchema)
    .describe('The moment each cell shows, left to right then top to bottom'),
};

export interface ContactSheetArgs {
  video: string;
  count: number;
  start?: string;
  end?: string;
  columns: number;
}

export async function contactSheetHandler(args: ContactSheetArgs): Promise<CallToolResult> {
  const { video, count, columns } = args;

  const sheet = await captureContactSheet(
    video,
    {
      count,
      start: parseOptionalTimestamp(args.start, 'start'),
      end: parseOptionalTimestamp(args.end, 'end'),
    },
    columns
  );

  const readings = sheet.timestamps.map(formatTimestamp);
  const legend = Array.from({ length: sheet.rows }, (_, row) => {
    const cells = readings.slice(row * sheet.columns, (row + 1) * sheet.columns);
    return `Row ${row + 1}: ${cells.join(', ')}`;
  });

  return {
    content: [
      textBlock(
        [
          `${sheet.title}: contact sheet, ${sheet.timestamps.length} frames in ${sheet.rows} rows`,
          'Read left to right, top to bottom.',
          ...legend,
        ].join('\n')
      ),
      imageBlock(sheet.bytes, JPEG_MIME),
    ],
    structuredContent: {
      videoId: sheet.videoId,
      title: sheet.title,
      columns: sheet.columns,
      rows: sheet.rows,
      mimeType: JPEG_MIME,
      cells: sheet.timestamps.map((seconds) => videoMoment(sheet.videoId, seconds)),
    },
  };
}
