import { execa, ExecaError } from 'execa';
import { currentContext, log } from './context.js';
import { YouTubeError, classifyYtDlpFailure } from './errors.js';
import { acquireSlot, releaseSlot } from './ytdlp-limiter.js';

export { concurrencyState } from './ytdlp-limiter.js';
export { isRecord, parseYtDlpJson, parseYtDlpJsonLines } from './ytdlp-parse.js';

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

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 750;
/** Guards against a pathological video description blowing up memory. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Seconds of socket inactivity before yt-dlp gives up on a connection.
 *
 * Media transfers deliberately run without a wall-clock timeout — a long clip
 * is allowed to take as long as it honestly takes — which left a dead
 * connection indistinguishable from a slow one, holding its concurrency slot
 * forever. This bounds the silence, not the work: a transfer still making
 * progress is never interrupted.
 */
const SOCKET_TIMEOUT_S = '30';

export interface RunOptions {
  /** Milliseconds before the child is killed. 0 disables the timeout. */
  timeoutMs?: number;
  /** Retry transient failures with backoff. Off for anything that writes files. */
  retry?: boolean;
  /** Human-readable operation name, used in log lines. */
  label?: string;
  /**
   * The URL, search expression or id yt-dlp operates on.
   *
   * Always the last argument and always preceded by a literal `--`, so a value
   * that begins with a dash is a target yt-dlp fails to fetch, never an option
   * it obeys. Required rather than defaulted: a call site cannot forget it.
   */
  target: string;
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
 * titles and user-supplied queries cannot become shell metacharacters. The
 * target follows a `--` terminator, so it cannot become a yt-dlp option either.
 */
export async function runYtDlp(args: string[], options: RunOptions): Promise<string> {
  const { timeoutMs = TIMEOUTS.metadata, retry = true, label = 'yt-dlp', target } = options;
  const { signal } = currentContext();
  const maxAttempts = retry ? MAX_ATTEMPTS : 1;

  for (let attempt = 1; ; attempt++) {
    // Not `signal.throwIfAborted()`: that throws a bare DOMException, which
    // reaches the client as a generic YTDLP_FAILED telling it to check its
    // yt-dlp install — for a request the client itself cancelled.
    if (signal?.aborted === true) {
      throw new YouTubeError('CANCELLED', 'The request was cancelled.');
    }

    try {
      return await spawnOnce(args, target, timeoutMs, signal);
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
  target: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<string> {
  await acquireSlot(signal);
  try {
    const argv = ['--socket-timeout', SOCKET_TIMEOUT_S, ...args, '--', target];
    const { stdout } = await execa('yt-dlp', argv, {
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
        'Install it with `pip install -U yt-dlp` (or `brew install yt-dlp`) and restart the server. Call check_health to verify.',
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
