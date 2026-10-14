/**
 * Merging the results of searching several corpora.
 *
 * A BM25 score depends on the corpus it came from: the same word is rare in one
 * channel and common in another, so a 90 from one and a 3 from another say nothing
 * about which passage answers better. Comparing them would quietly let the channel
 * with the most distinctive vocabulary win every query. Rank is the one thing the
 * lists share, so results are interleaved by rank, best of every list first.
 */

export interface RankedList<T> {
  /** What the list came from, carried onto each of its results. */
  source: string;
  /** Best first, as the corpus's own search returned them. */
  items: T[];
}

export interface Interleaved<T> {
  source: string;
  item: T;
}

interface Candidate<T> extends Interleaved<T> {
  rank: number;
  order: number;
}

/** Up to `limit` results: by rank, then the higher score, then the earlier list. */
export function interleaveByRank<T extends { score: number }>(
  lists: RankedList<T>[],
  limit: number
): Interleaved<T>[] {
  const candidates: Candidate<T>[] = lists.flatMap((list, order) =>
    list.items.map((item, rank) => ({ source: list.source, item, rank, order }))
  );

  return candidates
    .sort((a, b) => a.rank - b.rank || b.item.score - a.item.score || a.order - b.order)
    .slice(0, limit)
    .map(({ source, item }) => ({ source, item }));
}
