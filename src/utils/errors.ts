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
  | 'PREMIUM_ONLY'
  | 'LOGIN_REQUIRED'
  | 'BOT_CHECK'
  | 'NOT_FOUND'
  | 'NO_CAPTIONS'
  | 'LIVE_NOT_ENDED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'YTDLP_MISSING'
  | 'FFMPEG_MISSING'
  | 'YTDLP_FAILED'
  | 'FETCH_FAILED'
  | 'MALFORMED_RESPONSE'
  | 'INVALID_INPUT'
  | 'STORE_UNAVAILABLE'
  | 'STORE_CORRUPT';

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

/**
 * Why so little is read out of stderr.
 *
 * When YouTube refuses a video, the sentence yt-dlp prints is not yt-dlp's. It
 * is YouTube's own `playabilityStatus.reason`, fetched from the InnerTube API
 * and re-raised verbatim (`_video.py:4040-4048`). That text is localised to the
 * server's account settings, appears nowhere in yt-dlp's source, and YouTube
 * rewrites it at will — so there is no honest way to match on it. An earlier
 * revision of this file matched a dozen such sentences; the strings had been
 * written from memory of what YouTube "probably" says, and the tests asserting
 * them only proved that invented patterns match invented samples.
 *
 * What follows is therefore restricted to strings that yt-dlp itself
 * constructs, each quoted from the cited line of the installed copy. The reason
 * a video was refused is read from structured fields instead — see
 * `classifyPlayability`.
 */
interface Rule {
  code: YouTubeErrorCode;
  /** A literal substring, matched case-insensitively. Never a pattern. */
  emits: string;
  /** Where yt-dlp builds it, so a future reader can re-verify. */
  source: string;
  message: string;
  nextStep?: string;
  retryable?: boolean;
}

/** The two settings that let yt-dlp read what a signed-out client cannot. */
const COOKIE_HINT =
  'Set YOUTUBE_MCP_COOKIES_FROM_BROWSER (for example chrome) or YOUTUBE_MCP_COOKIES_FILE and restart the server; see the README section on signed-in content.';

const RULES: Rule[] = [
  {
    // The one YouTube-authored sentence matched here, and the reason is that
    // it was observed rather than remembered: on 2026-09-05 every per-video
    // read from this project's own address printed it, verbatim, while flat
    // channel listings kept working — so it is about the client, not the
    // video, and the remedy is different. Matched on the words before the
    // apostrophe, which YouTube writes as U+2019. Should YouTube reword it,
    // the login hint yt-dlp appends still lands on LOGIN_REQUIRED below, whose
    // next step names the same cookie settings. Listed first because both
    // strings appear in the same output.
    code: 'BOT_CHECK',
    emits: 'Sign in to confirm you',
    source: 'playabilityStatus.reason, re-raised by yt_dlp/extractor/youtube/_video.py',
    message: 'YouTube is asking this client to prove it is not a bot.',
    // Ordered by what was measured on 2026-09-06, not by what sounds most
    // technical. From a datacenter address every account-free lever was
    // installed and tested — a PO token provider (yt-dlp never even reaches
    // the point of requesting one; it fails at the player response first),
    // eight player clients, a 15-minute cooldown, and curl_cffi TLS
    // impersonation — and none of them changed the answer. So the address
    // comes first and the PO token provider comes last: leading with a remedy
    // that was measured not to work sends the reader down a dead end.
    nextStep: `Per-video reads are refused from this address. Datacenter and VPN/exit-node addresses are gated regardless of client settings, so check whether this host egresses through one. Otherwise: ${COOKIE_HINT} On a residential address a missing PO token provider can be the cause instead — check \`check_health\`.`,
  },
  {
    code: 'RATE_LIMITED',
    // exceptions.py formats `HTTP Error {status}: {reason}`; the reason for 429
    // is Python's http.HTTPStatus.TOO_MANY_REQUESTS.phrase.
    emits: 'HTTP Error 429',
    source: 'yt_dlp/networking/exceptions.py:63',
    message: 'YouTube is rate limiting this client.',
    nextStep: 'Wait a minute before retrying, and request fewer items per call.',
    retryable: true,
  },
  {
    code: 'NO_CAPTIONS',
    emits: 'There are no subtitles for the requested languages',
    source: 'yt_dlp/YoutubeDL.py:4459',
    message: 'No captions are available for this video in the requested language.',
    nextStep:
      'Call get_transcript again with a different language, or read the description instead.',
  },
  {
    code: 'FFMPEG_MISSING',
    emits: 'but ffmpeg is not installed',
    source: 'yt_dlp/YoutubeDL.py:3545',
    message: 'ffmpeg is required for this operation but is not installed.',
    nextStep: 'Install ffmpeg and call check_health to confirm it is on PATH.',
  },
  {
    code: 'FFMPEG_MISSING',
    emits: 'ffmpeg not found. Please install or provide the path using --ffmpeg-location',
    source: 'yt_dlp/postprocessor/ffmpeg.py:225',
    message: 'ffmpeg is required for this operation but is not installed.',
    nextStep: 'Install ffmpeg and call check_health to confirm it is on PATH.',
  },
  {
    // Appended by yt-dlp whenever YouTube's refusal mentions signing in
    // (`_video.py:4052` calls `_youtube_login_hint`), whatever language that
    // refusal is written in. It is the one authentication signal we can read
    // off a failed extraction without guessing at YouTube's wording.
    code: 'LOGIN_REQUIRED',
    emits: 'for tips on effectively exporting YouTube cookies',
    source: 'yt_dlp/extractor/youtube/_base.py:664',
    message: 'This video requires a signed-in YouTube account.',
    nextStep: `It may be private, age-restricted or members-only. ${COOKIE_HINT}`,
  },
];

/**
 * Map raw yt-dlp stderr onto a typed error. Falls back to YTDLP_FAILED with a
 * deliberately generic message: unrecognised stderr is never forwarded to the
 * model, because it routinely contains the full command line and local paths.
 */
export function classifyYtDlpFailure(stderr: string, cause?: unknown): YouTubeError {
  const haystack = stderr.toLowerCase();

  for (const rule of RULES) {
    if (haystack.includes(rule.emits.toLowerCase())) {
      return new YouTubeError(rule.code, rule.message, {
        nextStep: rule.nextStep,
        retryable: rule.retryable,
        cause,
      });
    }
  }

  return new YouTubeError('YTDLP_FAILED', 'yt-dlp could not complete this request.', {
    nextStep:
      'The video may be unavailable, or yt-dlp may be out of date — YouTube changes frequently and yt-dlp needs regular updates. Run `yt-dlp -U`, or call check_health for diagnostics.',
    cause,
  });
}

/**
 * Why a video cannot be read, taken from yt-dlp's structured output rather than
 * its prose.
 *
 * `availability` is a closed set built by `InfoExtractor._availability`
 * (`extractor/common.py:4010`) and documented at `common.py:413`; YouTube fills
 * it in at `_video.py:4559`, where `needs_auth` is exactly `age_limit >= 18` and
 * `needs_subscription` is the members-only badge. `live_status` is the closed
 * set documented at `common.py:392`.
 *
 * Both are enum members chosen by yt-dlp, so unlike stderr they are stable
 * across locales and across YouTube's copy changes.
 */
export function classifyPlayability(fields: {
  availability?: string;
  liveStatus?: string;
}): YouTubeError | undefined {
  switch (fields.availability) {
    case 'private':
      return new YouTubeError('PRIVATE', 'This video is private.', {
        nextStep: 'Only the owner and invited viewers can access it. Try a different video.',
      });
    case 'subscriber_only':
      return new YouTubeError('MEMBERS_ONLY', 'This video is restricted to channel members.', {
        nextStep: 'Members-only content cannot be accessed. Try a different video.',
      });
    case 'premium_only':
      return new YouTubeError('PREMIUM_ONLY', 'This video requires a YouTube Premium account.', {
        nextStep: 'Premium content cannot be accessed. Try a different video.',
      });
    case 'needs_auth':
      return new YouTubeError(
        'AGE_GATED',
        'This video is age-restricted and requires a signed-in account.',
        {
          nextStep: `Age-gated videos cannot be read without authentication. ${COOKIE_HINT}`,
        }
      );
  }

  // 'is_live' is deliberately absent: a stream in progress has real metadata,
  // and asking about one is a legitimate request.
  switch (fields.liveStatus) {
    case 'is_upcoming':
      return new YouTubeError('LIVE_NOT_ENDED', 'This live stream has not started yet.', {
        nextStep: 'Nothing has been broadcast. Try again once the stream has finished.',
      });
    case 'post_live':
      return new YouTubeError(
        'LIVE_NOT_ENDED',
        'This live stream has ended but is still processing.',
        {
          nextStep: 'YouTube has not published the recording yet. Try again later.',
          retryable: true,
        }
      );
  }

  return undefined;
}

/** Normalise anything thrown inside a tool handler into a YouTubeError. */
export function asYouTubeError(error: unknown): YouTubeError {
  if (error instanceof YouTubeError) return error;

  const message = error instanceof Error ? error.message : String(error);
  return new YouTubeError('YTDLP_FAILED', 'This request could not be completed.', {
    nextStep: 'Call check_health to verify yt-dlp and ffmpeg are installed and current.',
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
