import { execa } from 'execa';
import { createInterface } from 'node:readline';
import { currentContext } from './context.js';
import { acquireSlot, releaseSlot } from './ytdlp-limiter.js';
import { readYtDlpEnv } from './ytdlp-env.js';
import { YouTubeError } from './errors.js';
import { SOCKET_TIMEOUT_S } from './ytdlp.js';

/**
 * Running yt-dlp and reading its output a line at a time.
 *
 * `runYtDlp` buffers everything into a string, which is right for a metadata
 * read and wrong for a long walk: a 40,000-entry channel listing killed at
 * minute nine yields nothing at all, and the 64MB buffer is a hard ceiling.
 *
 * Here each line is handed over as it arrives, so a caller can checkpoint as
 * it goes and keep what it already had. Paired with `--lazy-playlist`, which
 * makes yt-dlp emit entries while it walks rather than after.
 */

export interface StreamOptions {
  label?: string;
  timeoutMs?: number;
  target: string;
  /** Called per line, in order. A throw here aborts the walk. */
  onLine: (line: string) => void;
}

export interface StreamResult {
  lines: number;
  /** False when the walk was cut short, so the caller knows not to claim completeness. */
  completed: boolean;
}

/**
 * Streams stdout line by line.
 *
 * A failure part-way through is not thrown away: the caller keeps every line
 * delivered so far and is told the walk did not complete, which is the whole
 * point of streaming rather than buffering.
 */
export async function runYtDlpLines(args: string[], options: StreamOptions): Promise<StreamResult> {
  const { timeoutMs = 0, target, onLine } = options;
  const { signal } = currentContext();

  if (signal?.aborted === true) {
    throw new YouTubeError('CANCELLED', 'The request was cancelled.');
  }

  await acquireSlot(signal);
  let lines = 0;

  try {
    const argv = [
      '--socket-timeout',
      SOCKET_TIMEOUT_S,
      ...readYtDlpEnv().args,
      ...args,
      '--',
      target,
    ];

    const child = execa('yt-dlp', argv, {
      timeout: timeoutMs > 0 ? timeoutMs : undefined,
      cancelSignal: signal,
      buffer: false,
      stdout: 'pipe',
    });

    // `stdout: 'pipe'` with `buffer: false` guarantees a stream here, so there
    // is nothing to guard against.
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of reader) {
      if (line.trim() === '') continue;
      onLine(line);
      lines += 1;
    }

    await child;
    return { lines, completed: true };
  } catch (error) {
    // Everything delivered so far is already the caller's. Reporting how far
    // it got matters more than the reason, which the caller can classify.
    if (error instanceof YouTubeError) throw error;
    return { lines, completed: false };
  } finally {
    releaseSlot();
  }
}
