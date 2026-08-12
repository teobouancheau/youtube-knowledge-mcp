import { execa, ExecaError } from 'execa';
import { currentContext, log } from './context.js';
import { YouTubeError, classifyYtDlpFailure } from './errors.js';

/**
 * The single place this server spawns yt-dlp.
 *
 * Everything that used to be missing lives here: a timeout on every call, a
 * concurrency cap so batch operations do not look like a scraper to YouTube,
 * backoff for the failures that are actually transient, and cancellation wired
 * to the MCP request so an abandoned request does not leave a process running.
 */

/** Per-operation time budgets. Downloads are bounded by the client, not by us. */
export const TIMEOUTS = {
  /** Metadata reads: one HTTP round trip plus parsing. */
  metadata: 30_000,
  /** Subtitle fetches: an extra file download. */
  transcript: 60_000,
  /** Comment fetches: paginates, so slower than plain metadata. */
  comments: 120_000,
  /** Media transfers: unbounded here; cancellation is the client's lever. */
  download: 0,
} as const;

const MAX_CONCURRENT = Number(process.env.YOUTUBE_MCP_MAX_CONCURRENCY ?? '3');
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 750;
/** Guards against a pathological video description blowing up memory. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

let active = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}

function releaseSlot(): void {
  active--;
  waiting.shift()?.();
}

/** Test seam: lets the suite assert the limiter without spawning processes. */
export function concurrencyState(): { active: number; queued: number; limit: number } {
  return { active, queued: waiting.length, limit: MAX_CONCURRENT };
}

export interface RunOptions {
  /** Milliseconds before the child is killed. 0 disables the timeout. */
  timeoutMs?: number;
  /** Retry transient failures with backoff. Off for anything that writes files. */
  retry?: boolean;
  /** Human-readable operation name, used in log lines. */
  label?: string;
}

function backoffDelay(attempt: number): number {
  // Exponential with full jitter, so parallel callers do not retry in lockstep.
  const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.round(Math.random() * ceiling);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new YouTubeError('CANCELLED', 'The request was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run yt-dlp and return its stdout.
 *
 * Arguments are always passed as an array — never a shell string — so video
 * titles and user-supplied queries cannot become shell metacharacters.
 */
export async function runYtDlp(args: string[], options: RunOptions = {}): Promise<string> {
  const { timeoutMs = TIMEOUTS.metadata, retry = true, label = 'yt-dlp' } = options;
  const { signal } = currentContext();
  const maxAttempts = retry ? MAX_ATTEMPTS : 1;

  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();

    try {
      return await spawnOnce(args, timeoutMs, signal);
    } catch (error) {
      const failure = translateExecaFailure(error, timeoutMs);
      if (!failure.retryable || attempt >= maxAttempts) throw failure;

      const delay = backoffDelay(attempt);
      log('warning', `${label} failed (${failure.code}), retrying in ${delay}ms`);
      // The slot is already released, so the backoff does not hold the queue.
      await sleep(delay, signal);
    }
  }
}

/** One attempt, holding a concurrency slot for exactly its duration. */
async function spawnOnce(
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<string> {
  await acquireSlot();
  try {
    const { stdout } = await execa('yt-dlp', args, {
      timeout: timeoutMs > 0 ? timeoutMs : undefined,
      cancelSignal: signal,
      maxBuffer: MAX_OUTPUT_BYTES,
      stripFinalNewline: true,
    });
    return stdout;
  } finally {
    releaseSlot();
  }
}

function translateExecaFailure(error: unknown, timeoutMs: number): YouTubeError {
  if (error instanceof YouTubeError) return error;

  if (!(error instanceof ExecaError)) {
    return classifyYtDlpFailure(error instanceof Error ? error.message : String(error), error);
  }

  if (error.isCanceled) {
    return new YouTubeError('CANCELLED', 'The request was cancelled.', { cause: error });
  }

  if (error.timedOut) {
    return new YouTubeError(
      'TIMEOUT',
      `yt-dlp did not respond within ${Math.round(timeoutMs / 1000)}s.`,
      {
        nextStep:
          'YouTube may be slow or the video unusually large. Retry, or request fewer items at once.',
        retryable: true,
        cause: error,
      }
    );
  }

  if (error.code === 'ENOENT') {
    return new YouTubeError('YTDLP_MISSING', 'yt-dlp is not installed or not on PATH.', {
      nextStep:
        'Install it with `pip install -U yt-dlp` (or `brew install yt-dlp`) and restart the server. Call health_check to verify.',
      cause: error,
    });
  }

  // execa types stderr by output mode, so read both fields defensively.
  const rawStderr: unknown = error.stderr;
  const rawSummary: unknown = error.shortMessage;
  return classifyYtDlpFailure(asText(rawStderr) || asText(rawSummary), error);
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.filter((line): line is string => typeof line === 'string').join('\n');
  }
  return '';
}

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
