import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Every way a YouTube operation can fail, as a closed set.
 *
 * The point of naming them is that the model calling this server gets a
 * sentence it can act on ("this video has no captions, try language X") rather
 * than a wall of yt-dlp stderr it has to guess at — and never a leaked command
 * line or stack trace.
 */
export type YouTubeErrorCode =
  | 'PRIVATE'
  | 'AGE_GATED'
  | 'MEMBERS_ONLY'
  | 'REGION_BLOCKED'
  | 'REMOVED'
  | 'NOT_FOUND'
  | 'NO_CAPTIONS'
  | 'LIVE_NOT_ENDED'
  | 'BOT_CHECK'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'YTDLP_MISSING'
  | 'FFMPEG_MISSING'
  | 'YTDLP_FAILED'
  | 'MALFORMED_RESPONSE'
  | 'INVALID_INPUT';

export interface YouTubeErrorOptions {
  /** What the caller should try next. Shown to the model verbatim. */
  nextStep?: string;
  /** True when a retry with backoff could plausibly succeed. */
  retryable?: boolean;
  cause?: unknown;
}

export class YouTubeError extends Error {
  readonly code: YouTubeErrorCode;
  readonly nextStep?: string;
  readonly retryable: boolean;

  constructor(code: YouTubeErrorCode, message: string, options: YouTubeErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'YouTubeError';
    this.code = code;
    this.nextStep = options.nextStep;
    this.retryable = options.retryable ?? false;
  }

  /** The single string a tool result carries: what went wrong, then what to do. */
  toToolMessage(): string {
    return this.nextStep ? `${this.message}\n\n${this.nextStep}` : this.message;
  }
}

interface Rule {
  code: YouTubeErrorCode;
  match: RegExp;
  message: string;
  nextStep?: string;
  retryable?: boolean;
}

/**
 * Ordered most-specific first — "Video unavailable" appears alongside more
 * precise reasons in real yt-dlp output, so the narrow rules must win.
 */
const RULES: Rule[] = [
  {
    code: 'BOT_CHECK',
    // Must not be loosened to "sign in to confirm you": that is also the prefix
    // of the age-gate message ("Sign in to confirm your age"), which is a
    // different, non-retryable failure.
    match: /confirm you'?re not a bot|cookies are no longer valid|not a bot/i,
    message: 'YouTube is challenging this request as automated traffic.',
    nextStep:
      'This usually clears on its own. Retry in a minute, or reduce how many videos you request at once. For sustained use, configure yt-dlp with browser cookies.',
    retryable: true,
  },
  {
    code: 'RATE_LIMITED',
    match: /HTTP Error 429|too many requests|rate.?limit/i,
    message: 'YouTube is rate limiting this client.',
    nextStep: 'Wait a minute before retrying, and request fewer items per call.',
    retryable: true,
  },
  {
    code: 'MEMBERS_ONLY',
    match: /members-only|available to this channel'?s members|join this channel/i,
    message: 'This video is restricted to channel members.',
    nextStep: 'Members-only content cannot be accessed. Try a different video.',
  },
  {
    code: 'AGE_GATED',
    match: /sign in to confirm your age|age-restricted|inappropriate for some users/i,
    message: 'This video is age-restricted and requires a signed-in account.',
    nextStep:
      'Age-gated videos cannot be read without authentication. Try a different video, or configure yt-dlp with browser cookies.',
  },
  {
    code: 'PRIVATE',
    match: /private video|this video is private/i,
    message: 'This video is private.',
    nextStep: 'Only the owner and invited viewers can access it. Try a different video.',
  },
  {
    code: 'REGION_BLOCKED',
    match:
      /available in your country|blocked it in your country|geo.?restrict|not available from your location/i,
    message: 'This video is blocked in the region this server runs from.',
    nextStep: 'Try a different video, or run the server from another region.',
  },
  {
    code: 'REMOVED',
    match:
      /has been removed|removed by the uploader|account associated with this video has been terminated|violat(?:ed|ing) .*(?:Terms of Service|Community Guidelines)/i,
    message: 'This video has been removed from YouTube.',
    nextStep: 'Search for a re-upload or an alternative source.',
  },
  {
    code: 'LIVE_NOT_ENDED',
    match:
      /premieres in|this live event will begin|is not yet available|live stream recording is not available/i,
    message: 'This is an upcoming or in-progress live stream.',
    nextStep:
      'Captions, chapters and downloads only exist once the stream has ended and been processed. Try again later.',
  },
  {
    code: 'NO_CAPTIONS',
    match:
      /no subtitles|there are no subtitles|requested format is not available.*sub|no automatic captions/i,
    message: 'No captions are available for this video in the requested language.',
    nextStep:
      'Call get_transcript again with a different language, or read the description instead.',
  },
  {
    code: 'NOT_FOUND',
    match:
      /video unavailable|unable to extract|incomplete youtube id|does not exist|is not a valid url/i,
    message: 'That video could not be found.',
    nextStep: 'Check the video ID or URL. Use search_videos to find the right one.',
  },
  {
    code: 'FFMPEG_MISSING',
    match: /ffmpeg (?:is )?not (?:found|installed)|you have requested merging.*ffmpeg|ffprobe/i,
    message: 'ffmpeg is required for this operation but is not installed.',
    nextStep:
      'Install ffmpeg and make sure it is on PATH (macOS: `brew install ffmpeg`, Debian/Ubuntu: `apt install ffmpeg`).',
  },
  {
    code: 'NETWORK',
    match:
      /HTTP Error 5\d\d|unable to download|connection (?:reset|refused|timed out)|temporary failure in name resolution|getaddrinfo|ECONNRESET|EAI_AGAIN/i,
    message: 'A network error occurred while contacting YouTube.',
    nextStep: 'This is usually transient. Retry shortly.',
    retryable: true,
  },
];

/**
 * Map raw yt-dlp stderr onto a typed error. Falls back to YTDLP_FAILED with a
 * deliberately generic message: unrecognised stderr is never forwarded to the
 * model, because it routinely contains the full command line and local paths.
 */
export function classifyYtDlpFailure(stderr: string, cause?: unknown): YouTubeError {
  for (const rule of RULES) {
    if (rule.match.test(stderr)) {
      return new YouTubeError(rule.code, rule.message, {
        nextStep: rule.nextStep,
        retryable: rule.retryable,
        cause,
      });
    }
  }

  return new YouTubeError('YTDLP_FAILED', 'yt-dlp could not complete this request.', {
    nextStep:
      'The video may be unavailable, or yt-dlp may be out of date — YouTube changes frequently and yt-dlp needs regular updates. Run `yt-dlp -U`, or call health_check for diagnostics.',
    cause,
  });
}

/** Normalise anything thrown inside a tool handler into a YouTubeError. */
export function asYouTubeError(error: unknown): YouTubeError {
  if (error instanceof YouTubeError) return error;

  const message = error instanceof Error ? error.message : String(error);
  return new YouTubeError('YTDLP_FAILED', 'This request could not be completed.', {
    nextStep: 'Call health_check to verify yt-dlp and ffmpeg are installed and current.',
    cause: error instanceof Error ? error : new Error(message),
  });
}

/**
 * Render an error as a tool result.
 *
 * Errors are reported inside the result with `isError`, not as JSON-RPC protocol
 * errors, so the model can read them and choose a different approach.
 */
export function toToolError(error: unknown): CallToolResult {
  const youTubeError = asYouTubeError(error);
  return {
    isError: true,
    content: [{ type: 'text', text: `[${youTubeError.code}] ${youTubeError.toToolMessage()}` }],
  };
}
