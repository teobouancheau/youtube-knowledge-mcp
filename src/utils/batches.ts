/**
 * Run `work` over the items, `size` at a time.
 *
 * Deliberately not a rolling window: a batch boundary is a natural place for a
 * checkpoint and a cancellation check, and the limiter inside yt-dlp is what
 * actually paces the network. Results come back in item order, whichever
 * finished first.
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
    const settled = await Promise.all(slice.map((item, offset) => work(item, start + offset)));
    results.push(...settled);
  }

  return results;
}
