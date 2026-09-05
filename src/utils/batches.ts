/**
 * Run `work` over the items, `size` at a time.
 *
 * Deliberately not a rolling window: a batch boundary is a natural place for a
 * checkpoint and a cancellation check, and the limiter inside yt-dlp is what
 * actually paces the network. Results come back in item order, whichever
 * finished first.
 *
 * A batch always settles before a failure propagates. `Promise.all` would
 * reject the moment one item did — on a cancelled request, before the items
 * already in flight had finished — and a checkpoint taken in that instant
 * would record none of them.
 */
export async function inBatches<T, R>(
  items: T[],
  size: number,
  work: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const width = Math.max(1, size);

  for (let start = 0; start < items.length; start += width) {
    const slice = items.slice(start, start + width);
    const settled = await Promise.allSettled(
      slice.map((item, offset) => work(item, start + offset))
    );

    for (const outcome of settled) {
      if (outcome.status === 'rejected') throw asError(outcome.reason);
      results.push(outcome.value);
    }
  }

  return results;
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
