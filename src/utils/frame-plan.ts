import { YouTubeError } from './errors.js';
import { roundToMillisecond } from './seconds.js';

/**
 * Deciding which moments of a video to look at.
 *
 * Pure, so every rule about what is a valid request lives in one place and is
 * testable without a video: the tools that take pictures only ever receive a
 * sorted list of timestamps that are known to exist.
 */

export interface FramePlanRequest {
  /** Exact moments, in seconds. Takes precedence over `count`. */
  timestamps?: number[];
  /** How many frames to spread evenly across the window. */
  count?: number;
  /** Window start in seconds. Default: 0. */
  start?: number;
  /** Window end in seconds. Default: the end of the video. */
  end?: number;
}

function pastTheEnd(seconds: number, duration: number): YouTubeError {
  return new YouTubeError(
    'INVALID_INPUT',
    `${Math.round(seconds)}s is past the end of this ${duration}s video.`,
    { nextStep: 'Pick a moment inside the video.' }
  );
}

function tooMany(max: number): YouTubeError {
  return new YouTubeError('INVALID_INPUT', `Ask for at most ${max} frames per call.`, {
    nextStep: 'Narrow the window, or make several calls.',
  });
}

function explicitTimestamps(timestamps: number[], duration: number, max: number): number[] {
  const unique = [...new Set(timestamps)].sort((a, b) => a - b);
  if (unique.length > max) throw tooMany(max);

  const beyond = unique.find((seconds) => duration > 0 && seconds >= duration);
  if (beyond !== undefined) throw pastTheEnd(beyond, duration);

  return unique;
}

function spacedTimestamps(request: FramePlanRequest, duration: number, max: number): number[] {
  const { count, start = 0 } = request;
  if (count === undefined || count < 1) {
    throw new YouTubeError('INVALID_INPUT', 'Pass at least 1 for count.');
  }
  if (count > max) throw tooMany(max);
  if (duration > 0 && start >= duration) throw pastTheEnd(start, duration);

  const requestedEnd = request.end ?? duration;
  if (requestedEnd <= 0) {
    throw new YouTubeError('INVALID_INPUT', 'Pass end when the video duration is unknown.');
  }
  if (requestedEnd <= start) {
    throw new YouTubeError('INVALID_INPUT', 'end must be later than start.');
  }

  const end = duration > 0 ? Math.min(requestedEnd, duration) : requestedEnd;
  const slice = (end - start) / count;

  // Midpoints: the first frame of a video is often black and the last may not exist.
  return Array.from({ length: count }, (_, index) =>
    roundToMillisecond(start + (index + 0.5) * slice)
  );
}

/**
 * The sorted timestamps to capture.
 *
 * `duration` of 0 means unknown, in which case nothing can be bounded by it.
 */
export function planTimestamps(request: FramePlanRequest, duration: number, max: number): number[] {
  const { timestamps, count } = request;

  if (timestamps !== undefined && timestamps.length > 0) {
    return explicitTimestamps(timestamps, duration, max);
  }

  if (count === undefined) {
    throw new YouTubeError('INVALID_INPUT', 'Provide timestamps or a count.', {
      nextStep: 'Pass timestamps for exact moments, or count to spread frames across the video.',
    });
  }

  return spacedTimestamps(request, duration, max);
}
