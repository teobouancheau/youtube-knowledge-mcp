import { YouTubeError } from './errors.js';

/**
 * A cancellable pause.
 *
 * Shared by the retry loop and the pacer so a cooling-down server still
 * answers a client that gives up: an uncancellable sleep is how a cooldown
 * turns into a wedge.
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    throw new YouTubeError('CANCELLED', 'The request was cancelled.');
  }

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
