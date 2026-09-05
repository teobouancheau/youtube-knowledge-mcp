import { describe, it, expect } from 'vitest';
import {
  YouTubeError,
  asYouTubeError,
  classifyPlayability,
  classifyYtDlpFailure,
  toToolError,
} from '../../src/utils/errors.js';
import { textOf } from '../helpers.js';

/**
 * Every sample below is a sentence yt-dlp itself builds, quoted from the cited
 * line of the installed copy (2026.07.04).
 *
 * Deliberately absent: YouTube's own refusal text ("Private video…", "Video
 * unavailable", "Join this channel to get access to members-only content"). It
 * reaches stderr verbatim from `playabilityStatus.reason`, exists nowhere in
 * yt-dlp's source, and is localised — asserting it here would only test our
 * memory of YouTube's copy against itself. Those cases are covered by
 * `classifyPlayability` below, against yt-dlp's structured fields.
 */
const SAMPLES: [string, string][] = [
  [
    // yt_dlp/networking/exceptions.py:63 formats `HTTP Error {status}: {reason}`.
    'RATE_LIMITED',
    'ERROR: unable to download video data: HTTP Error 429: Too Many Requests',
  ],
  [
    // yt_dlp/YoutubeDL.py:4459
    'NO_CAPTIONS',
    '[info] There are no subtitles for the requested languages',
  ],
  [
    // yt_dlp/YoutubeDL.py:3545
    'FFMPEG_MISSING',
    'ERROR: You have requested merging of multiple formats but ffmpeg is not installed',
  ],
  [
    // yt_dlp/postprocessor/ffmpeg.py:225
    'FFMPEG_MISSING',
    'ERROR: ffmpeg not found. Please install or provide the path using --ffmpeg-location',
  ],
  [
    // The one YouTube-authored line in this list, kept because it was captured
    // verbatim (curly apostrophe included) from yt-dlp 2026.07.04 on
    // 2026-09-05, not written from memory. See the rule's comment.
    'BOT_CHECK',
    'ERROR: [youtube] rPq7ITrWFvY: Sign in to confirm you’re not a bot. Use --cookies-from-browser or ' +
      '--cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  ' +
      'for how to manually pass cookies. Also see  https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies  ' +
      'for tips on effectively exporting YouTube cookies',
  ],
  [
    // yt_dlp/extractor/youtube/_base.py:664, appended by yt-dlp to whatever
    // refusal YouTube returned when that refusal mentions signing in.
    'LOGIN_REQUIRED',
    'ERROR: [youtube] abc: Some refusal we cannot read. Use --cookies-from-browser or --cookies for the ' +
      'authentication. Also see  https://github.com/yt-dlp/yt-dlp/wiki/FAQ  for tips on effectively ' +
      'exporting YouTube cookies',
  ],
];

describe('classifyYtDlpFailure', () => {
  it.each(SAMPLES)('maps stderr that yt-dlp itself builds to %s', (code, stderr) => {
    expect(classifyYtDlpFailure(stderr).code).toBe(code);
  });

  it('does not guess at YouTube-authored refusal text', () => {
    // This is what a private video really prints. It is YouTube's sentence, not
    // yt-dlp's, so the only honest answer is the generic one — a guess here
    // would silently mis-report the day YouTube rewords it.
    const stderr = 'ERROR: [youtube] abc: Private video. Sign in if you have been granted access';

    expect(classifyYtDlpFailure(stderr).code).toBe('YTDLP_FAILED');
  });

  it('points a bot check at the cookie settings, never at the video', () => {
    const error = classifyYtDlpFailure('Sign in to confirm you’re not a bot');
    expect(error.code).toBe('BOT_CHECK');
    expect(error.toToolMessage()).toContain('YOUTUBE_MCP_COOKIES_FROM_BROWSER');
  });

  it('marks only transient failures as retryable', () => {
    expect(classifyYtDlpFailure('HTTP Error 429: Too Many Requests').retryable).toBe(true);
    expect(classifyYtDlpFailure('ffmpeg not found. Please install').retryable).toBe(false);
  });

  it('never forwards unrecognised stderr to the caller', () => {
    const stderr =
      'ERROR: Traceback: /home/alice/.local/lib/python3.11/yt_dlp/extractor.py line 42 ' +
      "yt-dlp --cookies /home/alice/secrets/cookies.txt 'https://youtube.com/watch?v=x'";

    const error = classifyYtDlpFailure(stderr);

    expect(error.code).toBe('YTDLP_FAILED');
    expect(error.toToolMessage()).not.toContain('alice');
    expect(error.toToolMessage()).not.toContain('cookies');
    expect(error.toToolMessage()).not.toContain('Traceback');
  });

  it('keeps the original failure as the cause for server-side debugging', () => {
    const cause = new Error('original');
    expect(classifyYtDlpFailure('anything', cause).cause).toBe(cause);
  });
});

/**
 * The closed sets yt-dlp documents: `availability` at extractor/common.py:413
 * and built by `_availability` at common.py:4010, `live_status` at
 * common.py:392. Every member is covered, so a new one added upstream shows up
 * here as an untested value rather than as a silent fallthrough.
 */
describe('classifyPlayability', () => {
  it.each([
    ['private', 'PRIVATE'],
    ['subscriber_only', 'MEMBERS_ONLY'],
    ['premium_only', 'PREMIUM_ONLY'],
    ['needs_auth', 'AGE_GATED'],
  ])('reads availability %s as %s', (availability, code) => {
    expect(classifyPlayability({ availability })?.code).toBe(code);
  });

  it.each(['public', 'unlisted'])('treats availability %s as readable', (availability) => {
    expect(classifyPlayability({ availability })).toBeUndefined();
  });

  it.each([
    ['is_upcoming', 'LIVE_NOT_ENDED'],
    ['post_live', 'LIVE_NOT_ENDED'],
  ])('reads live_status %s as %s', (liveStatus, code) => {
    expect(classifyPlayability({ liveStatus })?.code).toBe(code);
  });

  it.each(['is_live', 'was_live', 'not_live'])(
    'treats live_status %s as readable',
    (liveStatus) => {
      // A stream in progress has real metadata; asking about one is legitimate.
      expect(classifyPlayability({ liveStatus })).toBeUndefined();
    }
  );

  it('marks a still-processing recording as retryable, and a refusal as not', () => {
    expect(classifyPlayability({ liveStatus: 'post_live' })?.retryable).toBe(true);
    expect(classifyPlayability({ availability: 'private' })?.retryable).toBe(false);
  });

  it('says nothing when yt-dlp reported nothing', () => {
    expect(classifyPlayability({})).toBeUndefined();
    // "NA" is yt-dlp's placeholder for an absent --print field (YoutubeDL.py:1388).
    expect(classifyPlayability({ availability: 'NA', liveStatus: 'NA' })).toBeUndefined();
  });

  it('prefers the availability reason when both are restrictive', () => {
    expect(classifyPlayability({ availability: 'private', liveStatus: 'is_upcoming' })?.code).toBe(
      'PRIVATE'
    );
  });
});

describe('YouTubeError', () => {
  it('appends the next step to the message', () => {
    const error = new YouTubeError('NO_CAPTIONS', 'No captions.', { nextStep: 'Try "fr".' });
    expect(error.toToolMessage()).toBe('No captions.\n\nTry "fr".');
  });

  it('omits the separator when there is no next step', () => {
    expect(new YouTubeError('TIMEOUT', 'Timed out.').toToolMessage()).toBe('Timed out.');
  });
});

describe('asYouTubeError', () => {
  it('passes typed errors through untouched', () => {
    const original = new YouTubeError('PRIVATE', 'Private.');
    expect(asYouTubeError(original)).toBe(original);
  });

  it('wraps unknown throws without leaking their message', () => {
    const converted = asYouTubeError(new Error('ENOENT /home/alice/.config/secret'));
    expect(converted.code).toBe('YTDLP_FAILED');
    expect(converted.toToolMessage()).not.toContain('alice');
  });

  it('handles non-Error throws', () => {
    expect(asYouTubeError('a string').code).toBe('YTDLP_FAILED');
  });
});

describe('toToolError', () => {
  it('reports errors in the result rather than as a protocol failure', () => {
    const result = toToolError(
      new YouTubeError('PRIVATE', 'Private.', { nextStep: 'Pick another.' })
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('[PRIVATE] Private.\n\nPick another.');
  });
});
