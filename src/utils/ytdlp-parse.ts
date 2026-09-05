import { YouTubeError } from './errors.js';

/** Reading yt-dlp's JSON output without trusting its shape. */

/**
 * Parse yt-dlp JSON output behind a type guard.
 *
 * Every JSON.parse in this codebase used to be unguarded, so a truncated or
 * non-JSON response surfaced as a raw SyntaxError.
 */
export function parseYtDlpJson<T>(
  stdout: string,
  guard: (value: unknown) => value is T,
  what: string
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new YouTubeError('MALFORMED_RESPONSE', `yt-dlp returned unreadable output for ${what}.`, {
      nextStep: 'This usually means yt-dlp is out of date. Run `yt-dlp -U` and try again.',
      retryable: true,
      cause: error,
    });
  }

  if (!guard(parsed)) {
    throw new YouTubeError(
      'MALFORMED_RESPONSE',
      `yt-dlp returned an unexpected shape for ${what}.`,
      {
        nextStep: 'This usually means yt-dlp is out of date. Run `yt-dlp -U` and try again.',
      }
    );
  }

  return parsed;
}

/** Parse newline-delimited JSON, skipping unparseable lines rather than failing the call. */
export function parseYtDlpJsonLines<T>(stdout: string, guard: (value: unknown) => value is T): T[] {
  const results: T[] = [];

  for (const line of stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (guard(parsed)) results.push(parsed);
    } catch {
      // A single malformed row should not lose the whole result set.
    }
  }

  return results;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
