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
import {
  catalogCounts,
  pendingVideoIds,
  saveVideoDetail,
} from '../../src/utils/video-detail-store.js';
import { MAX_DETAIL_JSON_BYTES, type videoStatsRowSchema } from '../../src/utils/video-stats.js';
import type { z } from 'zod';

type Row = z.infer<typeof videoStatsRowSchema>;

const ROW: Row = {
  id: 'v1',
  title: 'Camera review',
  channel_id: 'UCch',
  upload_date: '20260105',
  duration: 601.4,
  view_count: 1200,
  like_count: 80,
  comment_count: 45,
  availability: 'public',
  live_status: 'not_live',
  description: 'hello',
  thumbnail: 'https://i.ytimg.com/vi/v1/maxresdefault.jpg',
  categories: ['Science & Technology'],
  tags: ['camera'],
  heatmap: [
    { start_time: 0, end_time: 10, value: 0.4 },
    { start_time: 10, end_time: 20, value: 0.9 },
  ],
  automatic_captions: { en: [{ url: 'https://example.com/expiring' }] },
  subtitles: { fr: [{ url: 'https://example.com/expiring2' }] },
};

async function seed(): Promise<Awaited<ReturnType<typeof getStore>>> {
  const store = await getStore();
  store.exec(
    "INSERT INTO channel(channel_id, name, first_seen_at, updated_at) VALUES ('UCch','Ex',1,1)"
  );
  const insert = store.prepare(
    "INSERT INTO video (video_id, channel_id, title, tab, also_in_tabs, catalog_rank) VALUES (?,?,?,'videos','[]',?)"
  );
  insert.run('v1', 'UCch', 'Camera review', 0);
  insert.run('v2', 'UCch', 'Battery test', 1);
  insert.run('v3', 'UCch', 'Lens test', 2);
  store.exec(
    "INSERT INTO channel(channel_id, name, first_seen_at, updated_at) VALUES ('UCother','Other',1,1)"
  );
  insert.run('o1', 'UCother', 'Elsewhere', 0);
  return store;
}

function stored(
  store: Awaited<ReturnType<typeof getStore>>,
  id: string
): Record<string, string | number | null> {
  const row = store.prepare('SELECT * FROM video WHERE video_id = ?').get(id);
  return row as Record<string, string | number | null>;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-detail-'));
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
});

describe('saveVideoDetail', () => {
  it('marks the video as read, and keeps the record and the replay heatmap', async () => {
    const store = await seed();

    saveVideoDetail(store, ROW, 1_700_000_000_000);

    const row = stored(store, 'v1');
    expect(row.detail_at).toBe(1_700_000_000_000);
    expect(JSON.parse(String(row.detail_json))).toMatchObject({
      id: 'v1',
      categories: ['Science & Technology'],
    });
    expect(JSON.parse(String(row.heatmap_json))).toEqual(ROW.heatmap);
  });

  it('never stores the expiring caption URLs, which are most of a raw record', async () => {
    const store = await seed();

    saveVideoDetail(store, ROW, 1);

    const json = String(stored(store, 'v1').detail_json);
    expect(json).not.toContain('expiring');
    expect(json).not.toContain('automatic_captions');
    expect(json).not.toContain('"heatmap"');
  });

  it('refreshes the numbers YouTube states, which only a metadata read may set', async () => {
    const store = await seed();

    saveVideoDetail(store, ROW, 1);

    expect(stored(store, 'v1')).toMatchObject({
      comment_count: 45,
      like_count: 80,
      view_count: 1200,
      upload_date: '20260105',
      duration_s: 601,
      availability: 'public',
      live_status: 'not_live',
    });
  });

  it('keeps what the listing knew when the read says nothing about it', async () => {
    const store = await seed();
    store.exec("UPDATE video SET view_count = 7, duration_s = 99 WHERE video_id = 'v1'");

    saveVideoDetail(store, { id: 'v1' }, 1);

    expect(stored(store, 'v1')).toMatchObject({ view_count: 7, duration_s: 99, detail_at: 1 });
  });

  it('stores no heatmap for a video that has none', async () => {
    const store = await seed();

    saveVideoDetail(store, { ...ROW, heatmap: [] }, 1);

    expect(stored(store, 'v1').heatmap_json).toBeNull();
  });

  it('keeps a record that would be too large by dropping its bulkiest parts, and says so', async () => {
    const store = await seed();
    const tags = Array.from({ length: 2_000 }, (_, index) => `tag-number-${String(index)}`);

    saveVideoDetail(store, { ...ROW, tags }, 1);

    const json = String(stored(store, 'v1').detail_json);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_DETAIL_JSON_BYTES);
    expect(JSON.parse(json)).toMatchObject({ id: 'v1', detail_truncated: true });
  });

  it('does not invent a video the catalogue never saw', async () => {
    const store = await seed();

    saveVideoDetail(store, { ...ROW, id: 'unknown' }, 1);

    expect(store.prepare("SELECT 1 FROM video WHERE video_id = 'unknown'").get()).toBeUndefined();
  });
});

describe('pendingVideoIds', () => {
  it('lists the channel’s videos not yet read, in catalogue order, up to the limit', async () => {
    const store = await seed();
    saveVideoDetail(store, ROW, 1);

    expect(pendingVideoIds(store, 'UCch', 10)).toEqual(['v2', 'v3']);
    expect(pendingVideoIds(store, 'UCch', 1)).toEqual(['v2']);
  });

  it('leaves other channels alone', async () => {
    const store = await seed();

    expect(pendingVideoIds(store, 'UCother', 10)).toEqual(['o1']);
  });
});

describe('catalogCounts', () => {
  it('counts the channel’s videos and how many have been read', async () => {
    const store = await seed();
    saveVideoDetail(store, ROW, 1);

    expect(catalogCounts(store, 'UCch')).toEqual({ videos: 3, detailed: 1 });
  });

  it('counts nothing for a channel it has never seen', async () => {
    const store = await seed();

    expect(catalogCounts(store, 'UCnone')).toEqual({ videos: 0, detailed: 0 });
  });
});
