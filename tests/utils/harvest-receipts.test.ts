import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

import { closeStore, getStore, inTransaction } from '../../src/utils/store.js';
import { coverageOf } from '../../src/utils/coverage.js';
import {
  countReceipts,
  listReceipts,
  readReceipt,
  saveReceipt,
} from '../../src/utils/harvest-receipts.js';

const AT = new Date('2026-09-06T12:00:00.000Z');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-receipts-'));
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
});

describe('receipt persistence', () => {
  it('round-trips a complete receipt through the store', async () => {
    const store = await getStore();
    const coverage = coverageOf({
      scope: 'video-comments',
      targetId: 'dQw4w9WgXcQ',
      have: 120,
      expected: { value: 120, source: 'youtube:comment_count' },
      source: 'yt-dlp --write-comments',
      harvestedAt: AT,
    });

    saveReceipt(store, coverage);
    const read = readReceipt(store, 'video-comments', 'dQw4w9WgXcQ');

    expect(read?.complete).toBe(true);
    expect(read?.expected).toBe(120);
    expect(read?.expectedSource).toBe('youtube:comment_count');
    expect(read?.have).toBe(120);
  });

  it('round-trips an incomplete receipt with its resume token', async () => {
    const store = await getStore();
    saveReceipt(
      store,
      coverageOf({
        scope: 'channel-catalog',
        targetId: 'UCK8sQmJBp8GCxrOtXWBpyEA',
        have: 500,
        limitApplied: 500,
        source: 'yt-dlp --flat-playlist',
        resumeToken: 'catalog:UCK8sQmJBp8GCxrOtXWBpyEA',
        harvestedAt: AT,
      })
    );

    const read = readReceipt(store, 'channel-catalog', 'UCK8sQmJBp8GCxrOtXWBpyEA');
    expect(read?.complete).toBe(false);
    expect(read?.reason).toBe('CAP_REACHED');
    expect(read?.resumeToken).toBe('catalog:UCK8sQmJBp8GCxrOtXWBpyEA');
    expect(read?.expected).toBeUndefined();
  });

  it('replaces a receipt for the same target rather than duplicating it', async () => {
    const store = await getStore();
    const base = {
      scope: 'video-comments' as const,
      targetId: 'v1',
      source: 'test',
      harvestedAt: AT,
    };

    saveReceipt(store, coverageOf({ ...base, have: 10 }));
    saveReceipt(
      store,
      coverageOf({ ...base, have: 50, expected: { value: 50, source: 'youtube:comment_count' } })
    );

    expect(countReceipts(store)).toBe(1);
    expect(readReceipt(store, 'video-comments', 'v1')?.complete).toBe(true);
  });

  it('records an event per save, so a number can be explained afterwards', async () => {
    const store = await getStore();
    saveReceipt(
      store,
      coverageOf({
        scope: 'video-comments',
        targetId: 'v1',
        have: 10,
        source: 't',
        harvestedAt: AT,
      })
    );
    saveReceipt(
      store,
      coverageOf({
        scope: 'video-comments',
        targetId: 'v1',
        have: 30,
        source: 't',
        harvestedAt: AT,
      })
    );

    const events = store.prepare('SELECT delta FROM harvest_event ORDER BY event_id').all();
    expect(events.map((row) => row.delta)).toEqual([10, 30]);
  });

  it('rolls back rows and receipt together when the transaction fails', async () => {
    const store = await getStore();
    store.exec("INSERT INTO video(video_id) VALUES ('v1')");

    expect(() =>
      inTransaction(store, () => {
        store
          .prepare('INSERT INTO comment(comment_id, video_id, text, harvested_at) VALUES (?,?,?,?)')
          .run('c1', 'v1', 'hi', 1);
        saveReceipt(
          store,
          coverageOf({
            scope: 'video-comments',
            targetId: 'v1',
            have: 1,
            source: 't',
            harvestedAt: AT,
          })
        );
        throw new Error('interrupted');
      })
    ).toThrow('interrupted');

    // The property the whole store exists for: a receipt can never survive
    // without the rows it describes.
    expect(readReceipt(store, 'video-comments', 'v1')).toBeUndefined();
    expect(store.prepare('SELECT COUNT(*) AS n FROM comment').get()?.n).toBe(0);
  });

  it('refuses to persist a self-contradictory receipt', async () => {
    const store = await getStore();
    const good = coverageOf({
      scope: 'video-comments',
      targetId: 'v1',
      have: 5,
      expected: { value: 5, source: 'youtube:comment_count' },
      source: 't',
      harvestedAt: AT,
    });

    expect(() => {
      saveReceipt(store, { ...good, have: 1 });
    }).toThrow(/Coverage invariant/);
  });

  it('lists and counts receipts by scope', async () => {
    const store = await getStore();
    saveReceipt(
      store,
      coverageOf({ scope: 'video-comments', targetId: 'v1', have: 1, source: 't', harvestedAt: AT })
    );
    saveReceipt(
      store,
      coverageOf({
        scope: 'channel-catalog',
        targetId: 'UC1',
        have: 2,
        source: 't',
        harvestedAt: AT,
      })
    );

    expect(countReceipts(store)).toBe(2);
    expect(countReceipts(store, 'channel-catalog')).toBe(1);
    expect(listReceipts(store, { scope: 'channel-catalog' }).map((r) => r.targetId)).toEqual([
      'UC1',
    ]);
    expect(listReceipts(store, { limit: 1 })).toHaveLength(1);
  });
});
