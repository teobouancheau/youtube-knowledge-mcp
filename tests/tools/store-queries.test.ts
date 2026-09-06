import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textOf, structuredOf } from '../helpers.js';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

import { closeStore, getStore } from '../../src/utils/store.js';
import { saveThreads } from '../../src/utils/comment-store.js';
import { toThreads } from '../../src/utils/comment-threads.js';
import { saveReceipt } from '../../src/utils/harvest-receipts.js';
import { coverageOf } from '../../src/utils/coverage.js';
import { queryVideosHandler } from '../../src/tools/query-videos.js';
import { pruneHarvestHandler } from '../../src/tools/prune-harvest.js';

const QUERY = {
  minDurationSeconds: 0,
  detailedOnly: false,
  withComments: false,
  order: 'newest' as const,
  limit: 25,
  offset: 0,
};

async function seed(): Promise<Awaited<ReturnType<typeof getStore>>> {
  const store = await getStore();
  store.exec(
    "INSERT INTO channel(channel_id, name, first_seen_at, updated_at) VALUES ('UCch','Ex',1,1)"
  );
  store
    .prepare(
      `INSERT INTO video (video_id, channel_id, title, duration_s, upload_date, view_count, tab, also_in_tabs, catalog_rank, detail_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run('v1', 'UCch', 'Camera review', 600, '20260101', 900, 'videos', '["shorts"]', 0, 1);
  store
    .prepare(
      `INSERT INTO video (video_id, channel_id, title, duration_s, upload_date, view_count, tab, also_in_tabs, catalog_rank, detail_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    // No upload_date: only a flat listing has seen it, and flat entries carry none.
    .run('v2', 'UCch', 'Battery test', 60, null, 50, 'shorts', '[]', 1, null);

  saveThreads(
    store,
    'v1',
    toThreads([{ id: 'c1', parent: 'root', author: 'Alice', text: 'nice' }]).threads
  );
  return store;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-queries-'));
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
});

describe('query_videos', () => {
  it('lists what is catalogued, with how many comments are held', async () => {
    await seed();
    const structured = structuredOf(await queryVideosHandler(QUERY));

    expect(structured).toMatchObject({ total: 2, count: 2 });
    expect(JSON.stringify(structured.videos)).toContain('"storedComments":1');
  });

  it('reports an undated video as undated rather than ancient', async () => {
    await seed();
    const structured = structuredOf(await queryVideosHandler({ ...QUERY, order: 'oldest' }));
    const videos = JSON.parse(JSON.stringify(structured.videos)) as {
      videoId: string;
      uploadDate?: string;
    }[];

    expect(videos.find((video) => video.videoId === 'v2')?.uploadDate).toBeUndefined();
    // Sorting oldest-first must not put "unknown" ahead of a real date.
    expect(videos[0]?.videoId).toBe('v1');
  });

  it('excludes undated videos from a date filter instead of guessing', async () => {
    await seed();
    expect(structuredOf(await queryVideosHandler({ ...QUERY, since: '2025-01-01' }))).toMatchObject(
      {
        total: 1,
      }
    );
  });

  it('filters to videos that have comments held', async () => {
    await seed();
    expect(structuredOf(await queryVideosHandler({ ...QUERY, withComments: true }))).toMatchObject({
      total: 1,
    });
  });

  it('filters to videos whose full metadata was read', async () => {
    await seed();
    expect(structuredOf(await queryVideosHandler({ ...QUERY, detailedOnly: true }))).toMatchObject({
      total: 1,
    });
  });

  it('matches on the title', async () => {
    await seed();
    expect(structuredOf(await queryVideosHandler({ ...QUERY, match: 'battery' }))).toMatchObject({
      total: 1,
    });
  });

  it('reports the tabs a video appears in beyond its owner', async () => {
    await seed();
    expect(JSON.stringify(structuredOf(await queryVideosHandler(QUERY)))).toContain(
      '"alsoInTabs":["shorts"]'
    );
  });

  it('filters by channel and minimum duration', async () => {
    await seed();
    expect(structuredOf(await queryVideosHandler({ ...QUERY, channel: 'UCch' }))).toMatchObject({
      total: 2,
    });
    expect(
      structuredOf(await queryVideosHandler({ ...QUERY, minDurationSeconds: 100 }))
    ).toMatchObject({ total: 1 });
  });

  it('excludes undated videos from an upper date bound too', async () => {
    await seed();
    expect(structuredOf(await queryVideosHandler({ ...QUERY, until: '2027-01-01' }))).toMatchObject(
      {
        total: 1,
      }
    );
  });

  it('orders by views, comments held and catalogue position', async () => {
    await seed();
    const first = async (order: 'views' | 'comments' | 'catalog'): Promise<string> => {
      const structured = structuredOf(await queryVideosHandler({ ...QUERY, order }));
      const videos = JSON.parse(JSON.stringify(structured.videos)) as { videoId: string }[];
      return videos[0]?.videoId ?? '';
    };

    expect(await first('views')).toBe('v1');
    expect(await first('comments')).toBe('v1');
    expect(await first('catalog')).toBe('v1');
  });

  it('tolerates an unreadable also_in_tabs rather than failing the page', async () => {
    const store = await seed();
    store
      .prepare('UPDATE video SET also_in_tabs = ? WHERE video_id = ?')
      .run('"not-an-array"', 'v1');

    const structured = structuredOf(await queryVideosHandler(QUERY));
    expect(JSON.stringify(structured.videos)).toContain('"alsoInTabs":[]');
  });

  it('pages with a real offset, because the data is local', async () => {
    await seed();
    expect(structuredOf(await queryVideosHandler({ ...QUERY, limit: 1 }))).toMatchObject({
      total: 2,
      count: 1,
      hasMore: true,
      nextOffset: 1,
    });
  });

  it('warns when the channel behind the rows is only partly catalogued', async () => {
    const store = await seed();
    saveReceipt(
      store,
      coverageOf({
        scope: 'channel-catalog',
        targetId: 'UCch',
        have: 2,
        limitApplied: 2,
        source: 'test',
        resumeToken: 'more',
      })
    );

    expect(textOf(await queryVideosHandler(QUERY))).toContain('not its full video list');
  });
});

describe('prune_harvest', () => {
  const CONFIRM = { confirm: true as const, vacuum: false };

  it('removes comments while leaving the catalogue', async () => {
    await seed();
    const structured = structuredOf(await pruneHarvestHandler({ ...CONFIRM, scope: 'comments' }));

    expect(structured).toMatchObject({
      removed: { comments: 1 },
      remaining: { comments: 0, videos: 2, channels: 1 },
    });
  });

  it("removes one author's comments everywhere, as an erasure path", async () => {
    const store = await seed();
    saveThreads(
      store,
      'v1',
      toThreads([{ id: 'c2', parent: 'root', author: 'Bob', text: 'hi' }]).threads
    );

    const structured = structuredOf(
      await pruneHarvestHandler({ ...CONFIRM, author: 'Alice', scope: 'comments' })
    );

    expect(structured).toMatchObject({ removed: { comments: 1 }, remaining: { comments: 1 } });
  });

  it('cascades a channel deletion through its videos and comments', async () => {
    await seed();
    const structured = structuredOf(
      await pruneHarvestHandler({ ...CONFIRM, channel: 'UCch', scope: 'catalog' })
    );

    expect(structured).toMatchObject({ remaining: { channels: 0, videos: 0, comments: 0 } });
  });

  it('removes only the named video’s comments', async () => {
    await seed();
    const structured = structuredOf(
      await pruneHarvestHandler({ ...CONFIRM, video: 'v2', scope: 'comments' })
    );

    expect(structured).toMatchObject({ removed: { comments: 0 }, remaining: { comments: 1 } });
  });

  it('removes a channel’s comments without touching its catalogue', async () => {
    await seed();
    const structured = structuredOf(
      await pruneHarvestHandler({ ...CONFIRM, channel: 'UCch', scope: 'comments' })
    );

    expect(structured).toMatchObject({
      removed: { comments: 1 },
      remaining: { comments: 0, videos: 2, channels: 1 },
    });
  });

  it('clears everything when asked, and can vacuum', async () => {
    await seed();
    const structured = structuredOf(
      await pruneHarvestHandler({ confirm: true, vacuum: true, scope: 'all' })
    );

    expect(structured).toMatchObject({
      remaining: { comments: 0, videos: 0, channels: 0 },
      vacuumed: true,
    });
  });
});
