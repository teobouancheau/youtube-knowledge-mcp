import { YouTubeError } from './errors.js';
import { assertYouTubeUrl, CHANNEL_ID_PATTERN, VIDEO_ID_PATTERN } from './validate-youtube.js';

/**
 * Video ids, watch URLs and the duration formatter every YouTube module shares.
 *
 * Split out of youtube.ts so the modules that read video, channel, download
 * and transcript data can each depend on this without depending on each other.
 */

export function extractVideoId(urlOrId: string): string {
  // If it's already an ID (11 characters, no special chars except - and _)
  if (VIDEO_ID_PATTERN.test(urlOrId)) {
    return urlOrId;
  }

  // Try to extract from URL
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(urlOrId);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }

  // Truncated: the value is model-controlled and could be arbitrarily long.
  const shown = urlOrId.length > 64 ? `${urlOrId.slice(0, 61)}...` : urlOrId;
  throw new YouTubeError('INVALID_INPUT', `Could not extract video ID from: ${shown}`, {
    nextStep: 'Pass an 11-character video id or a youtube.com / youtu.be watch URL.',
  });
}

const HANDLE_PATTERN = /^@[\w.-]{1,50}$/;

/**
 * Turn a caller-supplied playlist or channel reference into a yt-dlp target.
 *
 * Three shapes are accepted — a URL on a YouTube host, an `@handle`, or a bare
 * channel id — and everything else is refused. This is the boundary that keeps
 * `fetch_videos` and friends from pointing yt-dlp at an arbitrary host.
 */
export function resolveListTarget(input: string): string {
  const trimmed = input.trim();

  if (HANDLE_PATTERN.test(trimmed)) return `https://www.youtube.com/${trimmed}`;
  if (CHANNEL_ID_PATTERN.test(trimmed)) return `https://www.youtube.com/channel/${trimmed}`;
  if (trimmed.includes('/') || trimmed.includes('.')) return assertYouTubeUrl(trimmed);

  throw new YouTubeError(
    'INVALID_INPUT',
    `"${trimmed.slice(0, 64)}" is not a playlist or channel.`,
    {
      nextStep: 'Pass a YouTube playlist or channel URL, an @handle, or a channel id.',
    }
  );
}

/**
 * The URL for a channel named any way a caller might name it: a URL (checked),
 * an `@handle`, or a bare name treated as a handle, which is what
 * `get_channel_info` has always done.
 */
export function channelUrlFor(channel: string): string {
  const trimmed = channel.trim();
  if (trimmed.includes('/') || trimmed.includes('://')) return assertYouTubeUrl(trimmed);
  return `https://www.youtube.com/${trimmed.startsWith('@') ? trimmed : `@${trimmed}`}`;
}

/** The canonical watch page for a video id. */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}
