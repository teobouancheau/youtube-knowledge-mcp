import { YouTubeError } from './errors.js';

/**
 * The concurrency limiter every yt-dlp spawn passes through.
 *
 * A cap so batch operations do not look like a scraper to YouTube, with a queue
 * that honours cancellation so an abandoned request never holds a place in it.
 */

const MAX_CONCURRENT = Number(process.env.YOUTUBE_MCP_MAX_CONCURRENCY ?? '3');

interface Waiter {
  grant: () => void;
  cancel: (error: YouTubeError) => void;
}

let active = 0;
const waiting: Waiter[] = [];

/**
 * Takes a concurrency slot, waiting for one when the limiter is full.
 *
 * The wait honours the request's abort signal. It used to be a bare promise
 * with no way out, so a client that gave up stayed queued forever — and since a
 * media transfer runs without a wall-clock timeout, three stalled downloads
 * held every slot and every later call queued behind them, uncancellable. The
 * server was not slow, it was wedged, and no tool could run again.
 */
export async function acquireSlot(signal: AbortSignal | undefined): Promise<void> {
  // No already-aborted check here: `runYtDlp` makes it before every attempt and
  // nothing awaits in between, so a second one could never fire — an
  // unreachable guard that reads like a reachable one.
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      grant: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      cancel: (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    };

    function onAbort(): void {
      const index = waiting.indexOf(waiter);
      if (index !== -1) waiting.splice(index, 1);
      waiter.cancel(new YouTubeError('CANCELLED', 'The request was cancelled.'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    waiting.push(waiter);
  });
}

/**
 * Hands the slot to the next waiter rather than freeing it and letting them
 * race for it: decrementing first left `active` below the limit for a tick, so
 * a fresh caller could take the slot the queue was already promised and the
 * limiter would run over its own ceiling.
 */
export function releaseSlot(): void {
  const next = waiting.shift();
  if (next) {
    next.grant();
    return;
  }
  active--;
}

/** Test seam: lets the suite assert the limiter without spawning processes. */
export function concurrencyState(): { active: number; queued: number; limit: number } {
  return { active, queued: waiting.length, limit: MAX_CONCURRENT };
}
