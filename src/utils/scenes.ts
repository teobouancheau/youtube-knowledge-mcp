import { YouTubeError } from './errors.js';
import { runFfmpeg } from './ffmpeg.js';
import { roundToMillisecond } from './seconds.js';
import { requireFfmpeg } from './preflight.js';
import {
  FFMPEG_NETWORK_INPUT_ARGS,
  resolveStreamUrl,
  SCAN_STREAM_SELECTOR,
} from './video-stream.js';
import { getVideoInfo } from './youtube.js';

/**
 * Finding where a video cuts.
 *
 * ffmpeg scores every frame by how different it is from the one before; frames
 * scoring above the threshold are cuts. Detection has to decode every frame of the
 * window, so it reads the lightest stream and only a bounded window at a time.
 */

/** A scan decodes every frame; this keeps one call to a few minutes of work. */
export const MAX_SCENE_WINDOW_SECONDS = 900;
export const MAX_SCENE_CUTS = 200;
export const DEFAULT_SCENE_THRESHOLD = 0.4;
const SCAN_TIMEOUT_MS = 300_000;

export interface ScanWindowRequest {
  start?: number;
  end?: number;
}

export interface SceneScanRequest extends ScanWindowRequest {
  /** 0 to 1: how different a frame must be from the last to count as a cut. */
  threshold: number;
}

export interface SceneScan {
  videoId: string;
  title: string;
  duration: number;
  start: number;
  end: number;
  threshold: number;
  /** Absolute video time of each cut, ascending. */
  cuts: number[];
  /** True when more cuts were found than are returned. */
  truncated: boolean;
}

/** Frames ffmpeg selected, as the times its showinfo filter logged them at. */
export function parseSceneCuts(stderr: string, offset: number): number[] {
  const times = stderr
    .split('\n')
    .filter((line) => line.includes('Parsed_showinfo'))
    .flatMap((line) => {
      const match = /pts_time:(\d+(?:\.\d+)?)/.exec(line);
      return match?.[1] === undefined ? [] : [roundToMillisecond(offset + Number(match[1]))];
    });

  return [...new Set(times)].sort((a, b) => a - b);
}

export function planScanWindow(
  request: ScanWindowRequest,
  duration: number
): { start: number; end: number } {
  const { start = 0 } = request;

  if (duration > 0 && start >= duration) {
    throw new YouTubeError(
      'INVALID_INPUT',
      `${Math.round(start)}s is past the end of this ${duration}s video.`,
      { nextStep: 'Pick a start time inside the video.' }
    );
  }

  const requestedEnd = request.end ?? start + MAX_SCENE_WINDOW_SECONDS;
  if (requestedEnd <= start) {
    throw new YouTubeError('INVALID_INPUT', 'end must be later than start.');
  }

  const end = duration > 0 ? Math.min(requestedEnd, duration) : requestedEnd;
  if (end - start > MAX_SCENE_WINDOW_SECONDS) {
    throw new YouTubeError(
      'INVALID_INPUT',
      `Scene detection reads at most ${MAX_SCENE_WINDOW_SECONDS}s per call.`,
      { nextStep: 'Scan the video in windows, moving start forward each time.' }
    );
  }

  return { start, end };
}

export async function detectScenes(video: string, request: SceneScanRequest): Promise<SceneScan> {
  await requireFfmpeg('Scene detection');
  const info = await getVideoInfo(video);
  const { start, end } = planScanWindow(request, info.duration);
  const { threshold } = request;

  const mediaUrl = await resolveStreamUrl(info.id, SCAN_STREAM_SELECTOR, 'Scene detection');

  const { stderr } = await runFfmpeg(
    [
      ...FFMPEG_NETWORK_INPUT_ARGS,
      // Both before -i: seek there, then read only the window.
      '-ss',
      String(start),
      '-t',
      String(end - start),
      '-i',
      mediaUrl,
      '-an',
      '-vf',
      `select=gt(scene\\,${String(threshold)}),showinfo`,
      '-f',
      'null',
      '-',
    ],
    {
      failure: 'ffmpeg could not scan this video for scene cuts.',
      nextStep: 'Try a shorter window, or check that ffmpeg works with network input.',
      timeoutMs: SCAN_TIMEOUT_MS,
    }
  );

  const cuts = parseSceneCuts(stderr, start);
  return {
    videoId: info.id,
    title: info.title,
    duration: info.duration,
    start,
    end,
    threshold,
    cuts: cuts.slice(0, MAX_SCENE_CUTS),
    truncated: cuts.length > MAX_SCENE_CUTS,
  };
}
