import { YouTubeError } from './errors.js';
import { FFMPEG_JPEG_QUALITY, runFfmpeg } from './ffmpeg.js';
import type { FramePlanRequest } from './frame-plan.js';
import { captureFrames } from './frames.js';
import { TIMEOUTS } from './ytdlp.js';

/**
 * A whole video's worth of looking in one picture.
 *
 * A model reading a video does not need every frame; it needs to see the shape of
 * it. Tiling a couple of dozen small stills into one image is a single inline
 * block instead of two dozen, and the order of the cells is the order of the
 * timestamps returned beside it, so no text has to be burned into the pixels.
 */

/** Each cell's width; four columns come to about 1300px, sharp but still a single block. */
export const SHEET_TILE_WIDTH = 320;
export const MAX_SHEET_FRAMES = 24;
export const DEFAULT_SHEET_COLUMNS = 4;

const TILE_GAP = 4;

export interface ContactSheet {
  bytes: Buffer;
  columns: number;
  rows: number;
}

export interface VideoContactSheet extends ContactSheet {
  videoId: string;
  title: string;
  duration: number;
  /** One per cell, left to right then top to bottom. */
  timestamps: number[];
}

export async function buildContactSheet(frames: Buffer[], columns: number): Promise<ContactSheet> {
  if (frames.length === 0) {
    throw new YouTubeError('INVALID_INPUT', 'A contact sheet needs at least one frame.');
  }

  // A grid wider than the frames it holds is only empty margin.
  const width = Math.max(1, Math.min(columns, frames.length));
  const rows = Math.ceil(frames.length / width);

  const failure = 'ffmpeg could not assemble the contact sheet.';
  const nextStep = 'Try fewer frames, or check that ffmpeg is working.';

  const { stdout } = await runFfmpeg(
    [
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-i',
      'pipe:0',
      '-vf',
      `tile=${String(width)}x${String(rows)}:margin=${String(TILE_GAP)}:padding=${String(TILE_GAP)}:color=black`,
      '-frames:v',
      '1',
      '-q:v',
      FFMPEG_JPEG_QUALITY,
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ],
    { failure, nextStep, timeoutMs: TIMEOUTS.transcript, input: Buffer.concat(frames) }
  );

  if (stdout.byteLength === 0) throw new YouTubeError('YTDLP_FAILED', failure, { nextStep });
  return { bytes: stdout, columns: width, rows };
}

export async function captureContactSheet(
  video: string,
  request: FramePlanRequest,
  columns: number
): Promise<VideoContactSheet> {
  const batch = await captureFrames(video, request, {
    width: SHEET_TILE_WIDTH,
    maxFrames: MAX_SHEET_FRAMES,
    label: 'Contact sheet',
  });
  const sheet = await buildContactSheet(
    batch.frames.map((frame) => frame.bytes),
    columns
  );

  return {
    ...sheet,
    videoId: batch.videoId,
    title: batch.title,
    duration: batch.duration,
    timestamps: batch.frames.map((frame) => frame.timestamp),
  };
}
