import { describe, it, expect } from 'vitest';
import {
  YouTubeError,
  asYouTubeError,
  classifyYtDlpFailure,
  toToolError,
} from '../../src/utils/errors.js';
import { textOf } from '../helpers.js';

/** Real stderr excerpts, so the patterns are tested against what yt-dlp emits. */
const SAMPLES: [string, string][] = [
  [
    'PRIVATE',
    'ERROR: [youtube] abc: Private video. Sign in if you have been granted access to this video',
  ],
  [
    'AGE_GATED',
    'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.',
  ],
  ['MEMBERS_ONLY', 'ERROR: [youtube] abc: Join this channel to get access to members-only content'],
  [
    'REGION_BLOCKED',
    'ERROR: [youtube] abc: The uploader has not made this video available in your country',
  ],
  ['REMOVED', 'ERROR: [youtube] abc: This video has been removed by the uploader'],
  ['NOT_FOUND', 'ERROR: [youtube] abc: Video unavailable'],
  ['NO_CAPTIONS', 'WARNING: [youtube] abc: There are no subtitles for the requested languages'],
  ['LIVE_NOT_ENDED', 'ERROR: [youtube] abc: This live event will begin in 3 hours'],
  ['BOT_CHECK', "ERROR: [youtube] abc: Sign in to confirm you're not a bot"],
  ['RATE_LIMITED', 'ERROR: unable to download video data: HTTP Error 429: Too Many Requests'],
  ['NETWORK', 'ERROR: unable to download video data: HTTP Error 503: Service Unavailable'],
  [
    'FFMPEG_MISSING',
    'ERROR: You have requested merging of multiple formats but ffmpeg is not installed',
  ],
];

describe('classifyYtDlpFailure', () => {
  it.each(SAMPLES)('maps real yt-dlp stderr to %s', (code, stderr) => {
    expect(classifyYtDlpFailure(stderr).code).toBe(code);
  });

  it('prefers the specific reason when generic text appears alongside it', () => {
    // yt-dlp routinely prints "Video unavailable" next to the real cause.
    const stderr = 'ERROR: [youtube] abc: Video unavailable. This video is private.';
    expect(classifyYtDlpFailure(stderr).code).toBe('PRIVATE');
  });

  it('marks only transient failures as retryable', () => {
    expect(classifyYtDlpFailure('HTTP Error 429: Too Many Requests').retryable).toBe(true);
    expect(classifyYtDlpFailure('This video is private').retryable).toBe(false);
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
