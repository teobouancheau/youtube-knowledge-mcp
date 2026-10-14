import { createHash } from 'node:crypto';
import { z } from 'zod';
import { currentContext } from './context.js';
import { YouTubeError } from './errors.js';
import { assertVideoId } from './validate.js';

/**
 * The stretches of a video the community has marked as sponsor reads, intros, outros
 * and the like, from SponsorBlock (https://sponsor.ajay.app), the database the whole
 * ecosystem uses.
 *
 * Its API is queried by the first four hex digits of the video id's SHA-256, never by
 * the id, so the service cannot tell which of the several videos sharing a prefix was
 * asked about. That is the privacy design SponsorBlock documents, and the only way this
 * module asks.
 */

const API = 'https://sponsor.ajay.app/api/skipSegments';
const HASH_PREFIX_LENGTH = 4;
const DEFAULT_TIMEOUT_MS = 15_000;
/** A hash prefix answers with every video sharing it; far more than this is not plausible. */
const MAX_RESPONSE_CHARS = 8_000_000;

/** SponsorBlock's documented categories that mark something a viewer may want to skip. */
export const SPONSOR_CATEGORIES = [
  'sponsor',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
  'preview',
  'music_offtopic',
  'filler',
] as const;

export type SponsorCategory = (typeof SPONSOR_CATEGORIES)[number];

export interface SponsorSegment {
  category: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  /** Community votes: higher is more agreed upon. */
  votes: number;
}

const responseSchema = z.array(
  z.object({
    videoID: z.string(),
    segments: z.array(
      z.object({
        category: z.string(),
        segment: z.tuple([z.number(), z.number()]),
        votes: z.number().optional(),
      })
    ),
  })
);

/**
 * The length covered by the segments, with overlaps counted once.
 *
 * SponsorBlock categories overlap (a sponsor read inside a self-promotion) and several
 * submissions can mark the same range, so a plain sum of durations is more than the
 * video can hold.
 */
export function coveredSeconds(segments: readonly SponsorSegment[]): number {
  let covered = 0;
  let reachedTo = Number.NEGATIVE_INFINITY;

  for (const { startSeconds, endSeconds } of [...segments].sort(
    (a, b) => a.startSeconds - b.startSeconds
  )) {
    const from = Math.max(startSeconds, reachedTo);
    if (endSeconds > from) covered += endSeconds - from;
    reachedTo = Math.max(reachedTo, endSeconds);
  }

  return covered;
}

export function hashPrefix(videoId: string): string {
  return createHash('sha256').update(videoId).digest('hex').slice(0, HASH_PREFIX_LENGTH);
}

function failure(message: string, cause?: unknown): YouTubeError {
  return new YouTubeError('FETCH_FAILED', message, {
    nextStep: 'SponsorBlock is a community service and may be down. Try again later.',
    retryable: true,
    cause,
  });
}

/**
 * The body as text, read as it arrives and abandoned once it passes the cap, so a
 * misbehaving service cannot make this process hold an unbounded response in memory.
 */
async function readBounded(response: Response): Promise<string> {
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
    if (text.length > MAX_RESPONSE_CHARS) {
      await reader.cancel();
      throw failure('SponsorBlock answered with too much data.');
    }
  }
}

async function request(url: URL, timeoutMs: number): Promise<{ status: number; text: string }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const { signal: cancelled } = currentContext();
  const signal = cancelled === undefined ? timeout : AbortSignal.any([cancelled, timeout]);

  try {
    // The host is fixed, so a redirect is never legitimate: refusing it keeps this
    // request on the one origin it was written for.
    const response = await fetch(url, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    return { status: response.status, text: await readBounded(response) };
  } catch (error) {
    if (error instanceof YouTubeError) throw error;
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new YouTubeError('TIMEOUT', 'SponsorBlock did not answer in time.', {
        nextStep: 'Try again later.',
        retryable: true,
        cause: error,
      });
    }
    if (cancelled?.aborted === true) {
      throw new YouTubeError('CANCELLED', 'The request was cancelled.');
    }
    throw failure('Could not reach SponsorBlock.', error);
  }
}

export async function fetchSponsorSegments(
  videoId: string,
  categories: readonly string[] = SPONSOR_CATEGORIES,
  options: { timeoutMs?: number } = {}
): Promise<SponsorSegment[]> {
  assertVideoId(videoId);

  const url = new URL(`${API}/${hashPrefix(videoId)}`);
  url.searchParams.set('categories', JSON.stringify(categories));

  const { status, text } = await request(url, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // 404 is how the service says no video sharing the prefix has any segment.
  if (status === 404) return [];
  if (status < 200 || status >= 300) {
    throw failure(`SponsorBlock answered with status ${String(status)}.`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new YouTubeError(
      'MALFORMED_RESPONSE',
      'SponsorBlock answered with something that is not JSON.',
      { cause: error }
    );
  }

  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    throw new YouTubeError(
      'MALFORMED_RESPONSE',
      'SponsorBlock answered in a shape this server does not know.',
      { cause: parsed.error }
    );
  }

  return parsed.data
    .filter((entry) => entry.videoID === videoId)
    .flatMap((entry) => entry.segments)
    .map(({ category, segment: [start, end], votes }) => ({
      category,
      startSeconds: start,
      endSeconds: end,
      durationSeconds: end - start,
      votes: votes ?? 0,
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds);
}
