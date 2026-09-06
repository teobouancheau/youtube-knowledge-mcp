import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

import { closeStore, getStore } from '../../src/utils/store.js';
import { countComments, queryComments, saveThreads } from '../../src/utils/comment-store.js';
import { toThreads } from '../../src/utils/comment-threads.js';

const ROWS = [
  {
    id: 'a1',
    parent: 'root',
    author: 'Alice',
    author_id: 'UCa',
    text: 'alpha',
    like_count: 10,
    timestamp: 300,
  },
  {
    id: 'a1.1',
    parent: 'a1',
    author: 'Bob',
    author_id: 'UCb',
    text: 'beta reply',
    like_count: 1,
    timestamp: 400,
  },
  {
    id: 'a2',
    parent: 'root',
    author: 'Alice',
    author_id: 'UCa',
    text: 'gamma',
    like_count: 99,
    timestamp: 100,
  },
];

async function seed(): Promise<Awaited<ReturnType<typeof getStore>>> {
  const store = await getStore();
  store.exec("INSERT INTO channel(channel_id, first_seen_at, updated_at) VALUES ('UCch', 1, 1)");
  store.exec("INSERT INTO video(video_id, channel_id) VALUES ('v1', 'UCch')");
  store.exec("INSERT INTO video(video_id) VALUES ('v2')");
  saveThreads(store, 'v1', toThreads(ROWS).threads);
  saveThreads(
    store,
    'v2',
    toThreads([{ id: 'b1', parent: 'root', author: 'Zed', text: 'alpha elsewhere' }]).threads
  );
  return store;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-cstore-'));
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
});

describe('comment store', () => {
  it('writes replies alongside their parents', async () => {
    const store = await seed();
    expect(countComments(store, { videoId: 'v1' })).toBe(3);
  });

  it('filters by channel through the video table', async () => {
    const store = await seed();
    expect(countComments(store, { channelId: 'UCch' })).toBe(3);
  });

  it('filters by author id or exact name', async () => {
    const store = await seed();
    expect(countComments(store, { authorId: 'UCa' })).toBe(2);
    expect(countComments(store, { authorId: 'Zed' })).toBe(1);
  });

  it('filters by minimum likes', async () => {
    const store = await seed();
    expect(countComments(store, { minLikes: 10 })).toBe(2);
  });

  it('orders by likes, newest and oldest', async () => {
    const store = await seed();
    const ids = (order: 'likes' | 'newest' | 'oldest'): string[] =>
      queryComments(store, { videoId: 'v1', order }).map((row) => row.comment_id);

    expect(ids('likes')[0]).toBe('a2');
    expect(ids('newest')[0]).toBe('a1.1');
    expect(ids('oldest')[0]).toBe('a2');
  });

  it('falls back to likes for relevance without a match', async () => {
    const store = await seed();
    expect(queryComments(store, { videoId: 'v1', order: 'relevance' })[0]?.comment_id).toBe('a2');
  });

  it('searches full text across videos', async () => {
    const store = await seed();
    expect(countComments(store, { match: 'alpha' })).toBe(2);
    expect(countComments(store, { match: 'beta' })).toBe(1);
  });

  it('pages with limit and offset', async () => {
    const store = await seed();
    const page = queryComments(store, { videoId: 'v1', limit: 1, offset: 1 });
    expect(page).toHaveLength(1);
  });

  it('keeps the FTS index in step when a comment is re-harvested', async () => {
    const store = await seed();
    saveThreads(
      store,
      'v1',
      toThreads([{ id: 'a1', parent: 'root', author: 'Alice', text: 'rewritten entirely' }]).threads
    );

    expect(countComments(store, { match: 'alpha' })).toBe(1);
    expect(countComments(store, { match: 'rewritten' })).toBe(1);
    // Upsert, not replace: the row count is unchanged.
    expect(countComments(store, { videoId: 'v1' })).toBe(3);
  });
});
