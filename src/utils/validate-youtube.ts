import { YouTubeError } from './errors.js';

/**
 * The identifiers and URLs this server is willing to hand to yt-dlp.
 *
 * A tool argument is model-controlled, and yt-dlp's generic extractor will
 * fetch any URL it is given — including internal addresses — so anything that
 * becomes a yt-dlp target is checked here first. Ids are also filenames, so the
 * real formats are matched exactly rather than sanitised.
 */

/** YouTube video ids are 11 base64url characters. */
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function assertVideoId(videoId: string): string {
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    throw new YouTubeError('INVALID_INPUT', `"${clip(videoId)}" is not a valid YouTube video id.`, {
      nextStep: 'Video ids are 11 characters, for example dQw4w9WgXcQ.',
    });
  }
  return videoId;
}

/**
 * YouTube channel ids are `UC` followed by 22 base64url characters.
 *
 * This is stricter than it looks like it needs to be. A channel id arrives from
 * yt-dlp's output and is then used as a directory name under
 * `~/.youtube-knowledge/brains`, so a value containing a separator or `..`
 * would write outside that tree. Matching the real format exactly is cheaper
 * than sanitising a value that should never have been unusual.
 */
export const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export function assertChannelId(channelId: string): string {
  if (!CHANNEL_ID_PATTERN.test(channelId)) {
    throw new YouTubeError(
      'INVALID_INPUT',
      `"${clip(channelId)}" is not a valid YouTube channel id.`,
      {
        nextStep:
          'Channel ids look like UCxxxxxxxxxxxxxxxxxxxxxx. Call get_channel_info or list_brains to get one.',
      }
    );
  }
  return channelId;
}

/** The hosts yt-dlp may be pointed at. Anything else is refused before it spawns. */
export const YOUTUBE_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
] as const;

const HOST_SET = new Set<string>(YOUTUBE_HOSTS);
const SCHEMELESS_YOUTUBE = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i;

/**
 * Validate a caller-supplied URL and return it normalised to https.
 *
 * `http:` is upgraded rather than refused, and a URL written without a scheme
 * but starting with a YouTube host is accepted, because both are things people
 * paste. Everything else — other hosts, other schemes, credentials, ports — is
 * an `INVALID_INPUT`, since the only reason to send one is to make yt-dlp fetch
 * something that is not YouTube.
 */
export function assertYouTubeUrl(input: string): string {
  const trimmed = input.trim();
  const candidate = SCHEMELESS_YOUTUBE.test(trimmed) ? `https://${trimmed}` : trimmed;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw notYouTube(input);
  }

  if (url.protocol === 'http:') url.protocol = 'https:';

  const wrongScheme = url.protocol !== 'https:';
  const wrongHost = !HOST_SET.has(url.hostname.toLowerCase());
  const hasCredentials = url.username !== '' || url.password !== '';
  const hasPort = url.port !== '';

  if (wrongScheme || wrongHost || hasCredentials || hasPort) throw notYouTube(input);

  return url.toString();
}

function notYouTube(input: string): YouTubeError {
  return new YouTubeError('INVALID_INPUT', `"${clip(input)}" is not a YouTube URL.`, {
    nextStep: `Pass an https URL on one of: ${YOUTUBE_HOSTS.join(', ')}.`,
  });
}

/** Keeps a rejected value from flooding the error message it is quoted in. */
function clip(value: string): string {
  return value.length > 64 ? `${value.slice(0, 61)}...` : value;
}
