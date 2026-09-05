import type { z } from 'zod';
import { YouTubeError } from './errors.js';

/** Reading yt-dlp's JSON output without trusting its shape. */

function outOfDate(what: string, detail: string, cause?: unknown): YouTubeError {
  return new YouTubeError('MALFORMED_RESPONSE', `yt-dlp returned ${detail} for ${what}.`, {
    nextStep: 'This usually means yt-dlp is out of date. Run `yt-dlp -U` and try again.',
    retryable: cause !== undefined,
    cause,
  });
}

/**
 * Parse yt-dlp JSON output against a schema.
 *
 * Every JSON.parse in this codebase used to be unguarded, so a truncated or
 * non-JSON response surfaced as a raw SyntaxError; and the guard that replaced
 * it only checked for an object, so a field of the wrong type still reached
 * the code that read it.
 */
export function parseYtDlpJson<T>(
  stdout: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  what: string
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw outOfDate(what, 'unreadable output', error);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) throw outOfDate(what, 'an unexpected shape');
  return result.data;
}

/** Parse newline-delimited JSON, skipping rows that do not parse or do not match. */
export function parseYtDlpJsonLines<T>(
  stdout: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): T[] {
  const results: T[] = [];

  for (const line of stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const result = schema.safeParse(JSON.parse(line));
      if (result.success) results.push(result.data);
    } catch {
      // A single malformed row should not lose the whole result set.
    }
  }

  return results;
}
