import { inBatches } from './batches.js';
import { YouTubeError } from './errors.js';
import { FFMPEG_JPEG_QUALITY, runFfmpeg } from './ffmpeg.js';
import { planTimestamps, type FramePlanRequest } from './frame-plan.js';
import { requireFfmpeg } from './preflight.js';
import {
  FFMPEG_NETWORK_INPUT_ARGS,
  PREVIEW_STREAM_SELECTOR,
  resolveStreamUrl,
} from './video-stream.js';
import { TIMEOUTS } from './ytdlp.js';
import { getVideoInfo } from './youtube.js';

/**
 * Looking at a video: stills captured into memory, never onto disk.
 *
 * A picture returned inline is something the model can read, which is what makes
 * "what is on screen at 3:20" answerable without a human in the loop. Nothing is
 * written, so the same code serves a contact sheet and a handful of stills.
 */

/** Each frame is an inline image, so a call is bounded by what a reply can carry. */
export const MAX_FRAMES_PER_CALL = 12;
/** Wide enough to read slide text, small enough to be about 100 KB a frame. */
export const DEFAULT_FRAME_WIDTH = 768;

/** Concurrent ffmpeg processes. Each is one ranged request against the same stream. */
const CAPTURE_CONCURRENCY = 4;

export interface CapturedFrame {
  timestamp: number;
  bytes: Buffer;
}

export interface FrameBatch {
  videoId: string;
  title: string;
  duration: number;
  frames: CapturedFrame[];
}

export interface CaptureOptions {
  /** Frames are shrunk to this width, never enlarged. */
  width: number;
  maxFrames: number;
  /** The tool asking, for the ffmpeg preflight message and yt-dlp logs. */
  label: string;
}

async function captureOne(
  mediaUrl: string,
  timestamp: number,
  width: number
): Promise<CapturedFrame> {
  const failure = `ffmpeg could not capture the frame at ${String(timestamp)}s.`;
  const nextStep = 'Try a different timestamp, or check that ffmpeg works with network input.';

  const { stdout } = await runFfmpeg(
    [
      ...FFMPEG_NETWORK_INPUT_ARGS,
      // -ss before -i seeks without decoding everything up to that point.
      '-ss',
      String(timestamp),
      '-i',
      mediaUrl,
      '-frames:v',
      '1',
      '-vf',
      `scale=min(${String(width)}\\,iw):-2`,
      '-q:v',
      FFMPEG_JPEG_QUALITY,
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ],
    { failure, nextStep, timeoutMs: TIMEOUTS.transcript }
  );

  if (stdout.byteLength === 0) throw new YouTubeError('YTDLP_FAILED', failure, { nextStep });
  return { timestamp, bytes: stdout };
}

/** Capture the frames a request describes, in timestamp order. */
export async function captureFrames(
  video: string,
  request: FramePlanRequest,
  options: CaptureOptions
): Promise<FrameBatch> {
  const { width, maxFrames, label } = options;

  // Cheap local checks first: a missing ffmpeg or an impossible request should
  // fail before a single network round trip.
  await requireFfmpeg(label);
  const info = await getVideoInfo(video);
  const timestamps = planTimestamps(request, info.duration, maxFrames);

  const mediaUrl = await resolveStreamUrl(info.id, PREVIEW_STREAM_SELECTOR, label);
  const frames = await inBatches(timestamps, CAPTURE_CONCURRENCY, (timestamp) =>
    captureOne(mediaUrl, timestamp, width)
  );

  return { videoId: info.id, title: info.title, duration: info.duration, frames };
}
