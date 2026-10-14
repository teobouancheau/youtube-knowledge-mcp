import { describe, it, expect } from 'vitest';
import { interleaveByRank } from '../../src/utils/brain-fusion.js';

interface Hit {
  id: string;
  score: number;
}

const hit = (id: string, score: number): Hit => ({ id, score });

describe('interleaveByRank', () => {
  it('takes the best of every list before the second best of any', () => {
    const merged = interleaveByRank(
      [
        { source: 'A', items: [hit('a1', 9), hit('a2', 8)] },
        { source: 'B', items: [hit('b1', 2), hit('b2', 1)] },
      ],
      3
    );

    expect(merged.map((entry) => entry.item.id)).toEqual(['a1', 'b1', 'a2']);
  });

  it('does not let a high score in one corpus outrank a better rank in another', () => {
    // Scores from different corpora are not on one scale, so a 90 in A says nothing
    // about whether it beats a 3 in B. Rank is the only thing they share.
    const merged = interleaveByRank(
      [
        { source: 'A', items: [hit('a1', 1), hit('a2', 90)] },
        { source: 'B', items: [hit('b1', 3)] },
      ],
      3
    );

    expect(merged.map((entry) => entry.item.id)).toEqual(['b1', 'a1', 'a2']);
  });

  it('puts the higher score first within a rank, and the earlier list first on a tie', () => {
    const merged = interleaveByRank(
      [
        { source: 'A', items: [hit('a1', 5)] },
        { source: 'B', items: [hit('b1', 7)] },
        { source: 'C', items: [hit('c1', 5)] },
      ],
      3
    );

    expect(merged.map((entry) => entry.item.id)).toEqual(['b1', 'a1', 'c1']);
  });

  it('says which list each result came from', () => {
    const [first] = interleaveByRank([{ source: 'UCabc', items: [hit('a1', 1)] }], 5);

    expect(first).toEqual({ source: 'UCabc', item: hit('a1', 1) });
  });

  it('stops at the limit, and returns everything when the limit is larger', () => {
    const lists = [{ source: 'A', items: [hit('a1', 3), hit('a2', 2), hit('a3', 1)] }];

    expect(interleaveByRank(lists, 2)).toHaveLength(2);
    expect(interleaveByRank(lists, 10)).toHaveLength(3);
    expect(interleaveByRank(lists, 0)).toEqual([]);
  });

  it('ignores lists with nothing in them', () => {
    const merged = interleaveByRank(
      [
        { source: 'A', items: [] },
        { source: 'B', items: [hit('b1', 1)] },
      ],
      5
    );

    expect(merged.map((entry) => entry.item.id)).toEqual(['b1']);
  });

  it('returns nothing for no lists', () => {
    expect(interleaveByRank<Hit>([], 5)).toEqual([]);
  });
});
