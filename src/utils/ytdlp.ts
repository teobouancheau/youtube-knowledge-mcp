import { execa, ExecaError } from 'execa';
import { currentContext, log } from './context.js';
import { sleep } from './sleep.js';
import { circuitOpen, onFailure, onSuccess, waitMs } from './ytdlp-pacer.js';
import { YouTubeError, classifyYtDlpFailure } from './errors.js';
import { acquireSlot, releaseSlot } from './ytdlp-limiter.js';
import { readYtDlpEnv } from './ytdlp-env.js';

export { concurrencyState } from './ytdlp-limiter.js';
export { parseYtDlpJson, parseYtDlpJsonLines } from './ytdlp-parse.js';

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
export const SOCKET_TIMEOUT_S = '30';

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

    // The cooldown gates NEW work, not this call's own retries: it applies on
    // the first attempt only. Mixing the two would make a single call's latency
    // unbounded — its retry would wait out a global cooldown that exists to
    // slow the *next* caller down. Retries use the backoff.
    //
    // Deliberately outside the try: an open circuit is this server's own
    // decision, not a spawn failure, and letting the catch below translate and
    // retry it would spawn the very request the circuit exists to prevent.
    // Waiting also happens before a slot is taken, so a cooling-down server
    // does not sit on the concurrency queue while it waits.
    const wait = attempt === 1 ? waitMs() : 0;
    if (wait > 0) {
      if (circuitOpen()) {
        throw new YouTubeError(
          'RATE_LIMITED',
          'YouTube has refused this client repeatedly, so requests are paused.',
          {
            nextStep: `Wait about ${String(Math.ceil(wait / 60_000))} minutes. If it persists this address is likely being gated: check check_health for the cookie and PO token provider settings.`,
            retryable: true,
          }
        );
      }
      log('info', `${label} waiting ${String(wait)}ms before spawning`);
      await sleep(wait, signal);
    }

    try {
      const stdout = await spawnOnce(args, target, timeoutMs, signal);
      onSuccess();
      return stdout;
    } catch (error) {
      const failure = translateExecaFailure(error, timeoutMs);
      const decision = onFailure(failure.code, attempt);
      if (decision.giveUp || attempt >= maxAttempts) throw failure;

      log(
        'warning',
        `${label} failed (${failure.code}), retrying in ${String(decision.delayMs)}ms`
      );
      // The slot is already released, so the backoff does not hold the queue.
      await sleep(decision.delayMs, signal);
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
    // Session flags (cookies, proxy, pacing) go first so a caller's argument can
    // never be read as their value; the target goes last, behind `--`.
    const argv = [
      '--socket-timeout',
      SOCKET_TIMEOUT_S,
      ...readYtDlpEnv().args,
      ...args,
      '--',
      target,
    ];
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
