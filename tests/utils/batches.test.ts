import { describe, it, expect, vi } from 'vitest';
import { inBatches } from '../../src/utils/batches.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('inBatches', () => {
  it('returns results in item order whatever order they finish in', async () => {
    const results = await inBatches([30, 10, 20], 3, async (ms) => {
      await wait(ms);
      return ms;
    });

    expect(results).toEqual([30, 10, 20]);
  });

  it('runs at most `size` items at once, and at least one', async () => {
    let inFlight = 0;
    let peak = 0;
    const work = async (): Promise<void> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await wait(3);
      inFlight--;
    };

    await inBatches([1, 2, 3, 4, 5], 2, work);
    expect(peak).toBe(2);

    peak = 0;
    await inBatches([1, 2], 0, work);
    expect(peak).toBe(1);
  });

  it('passes each item with its index and handles an empty list', async () => {
    const seen: [string, number][] = [];
    await inBatches(['a', 'b', 'c'], 2, (item, index) => {
      seen.push([item, index]);
      return Promise.resolve();
    });
    expect(seen).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
    expect(await inBatches([], 3, () => Promise.resolve(1))).toEqual([]);
  });

  it('lets every item of a batch settle before a failure propagates', async () => {
    const finished: number[] = [];
    const slow = async (n: number): Promise<number> => {
      await wait(10);
      finished.push(n);
      return n;
    };

    await expect(
      inBatches([1, 2, 3], 3, (n) => (n === 2 ? Promise.reject(new Error('two')) : slow(n)))
    ).rejects.toThrow('two');

    // The checkpoint a caller takes in its catch must see items 1 and 3 done.
    expect(finished.sort()).toEqual([1, 3]);
  });

  it('does not start the next batch after a failure', async () => {
    const started: number[] = [];
    await expect(
      inBatches([1, 2, 3, 4], 2, (n) => {
        started.push(n);
        return n === 1 ? Promise.reject(new Error('one')) : Promise.resolve(n);
      })
    ).rejects.toThrow('one');
    expect(started).toEqual([1, 2]);
  });

  it('wraps a non-Error rejection so the caller always gets an Error', async () => {
    // A mock is the one honest way to produce a rejection that is not an Error
    // without writing code the lint rules would rightly refuse.
    const work = vi.fn<(item: number) => Promise<number>>().mockRejectedValue('raw');

    const error = await inBatches([1], 1, work).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('raw');
  });
});
