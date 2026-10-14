import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

import { closeStore, getStore } from '../../src/utils/store.js';
import { saveThreads } from '../../src/utils/comment-store.js';
import { toThreads } from '../../src/utils/comment-threads.js';
import { coverageOf } from '../../src/utils/coverage.js';
import { saveReceipt } from '../../src/utils/harvest-receipts.js';
import { exportData, type ExportRequest } from '../../src/utils/export-data.js';

const CHANNEL = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const V1 = 'aaaaaaaaaa1';
const V2 = 'aaaaaaaaaa2';
const O1 = 'bbbbbbbbbb1';

type Store = Awaited<ReturnType<typeof getStore>>;

async function seed(): Promise<Store> {
  const store = await getStore();
  store.exec(
    `INSERT INTO channel(channel_id, name, first_seen_at, updated_at) VALUES ('${CHANNEL}','Ex',1,1), ('${OTHER}','Other',1,1)`
  );
  const insert = store.prepare(
    `INSERT INTO video (video_id, channel_id, title, duration_s, upload_date, view_count, tab, also_in_tabs, catalog_rank, detail_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  insert.run(V1, CHANNEL, 'Camera review', 600, '20260101', 900, 'videos', '["shorts"]', 0, 1);
  insert.run(V2, CHANNEL, 'Battery, "tested"', 60, null, 50, 'shorts', '[]', 1, null);
  insert.run(O1, OTHER, 'Elsewhere', 30, '20260102', 5, 'videos', '[]', 0, null);

  saveThreads(
    store,
    V1,
    toThreads([
      {
        id: 'c1',
        parent: 'root',
        author: 'Alice',
        text: 'nice',
        like_count: 7,
        timestamp: 1_767_225_600,
      },
      {
        id: 'c2',
        parent: 'root',
        author: 'Mallory',
        text: '=HYPERLINK("http://evil")',
        like_count: 1,
      },
      { id: 'c3', parent: 'c1', author: 'Bob', text: 'agreed' },
    ]).threads
  );
  saveReceipt(
    store,
    coverageOf({
      scope: 'channel-catalog',
      targetId: CHANNEL,
      have: 2,
      source: 'test',
      expected: { value: 2, source: 'source-exhausted' },
      ranToExhaustion: true,
    })
  );
  saveReceipt(
    store,
    coverageOf({
      scope: 'video-comments',
      targetId: V1,
      have: 3,
      source: 'test',
      expected: { value: 10, source: 'youtube:comment_count' },
    })
  );
  return store;
}

const videos = (overrides: Partial<ExportRequest> = {}): ExportRequest => ({
  dataset: 'videos',
  format: 'json',
  limit: 1000,
  ...overrides,
});

const comments = (overrides: Partial<ExportRequest> = {}): ExportRequest => ({
  dataset: 'comments',
  format: 'json',
  limit: 1000,
  ...overrides,
});

const read = (path: string): string => readFileSync(path, 'utf-8');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-export-'));
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
});

describe('exportData videos', () => {
  it('writes every catalogued video of a channel as JSON, with what is known of each', async () => {
    const store = await seed();

    const result = await exportData(store, videos({ channel: CHANNEL }));

    expect(result).toMatchObject({ dataset: 'videos', format: 'json', rows: 2, total: 2 });
    const doc = JSON.parse(read(result.filePath)) as { rows: Record<string, unknown>[] };
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows.find((row) => row.videoId === V1)).toMatchObject({
      channelId: CHANNEL,
      title: 'Camera review',
      durationSeconds: 600,
      uploadDate: '20260101',
      viewCount: 900,
      tab: 'videos',
      alsoInTabs: ['shorts'],
      detailed: true,
      storedComments: 3,
    });
  });

  it('takes its receipts with it, so the file cannot be read as complete when it is not', async () => {
    const store = await seed();

    const result = await exportData(store, videos({ channel: CHANNEL }));

    expect(
      result.coverage.map((receipt) => `${receipt.scope}:${String(receipt.complete)}`)
    ).toEqual(['channel-catalog:true']);
    const doc = JSON.parse(read(result.filePath)) as { coverage: unknown[] };
    expect(doc.coverage).toHaveLength(1);
  });

  it('names a channel whose rows have no receipt, since their completeness is unknown', async () => {
    const store = await seed();

    const result = await exportData(store, videos());

    expect(result.withoutReceipt).toEqual([`channel-catalog:${OTHER}`]);
  });

  it('survives a damaged tabs column, reading it as no extra tabs', async () => {
    const store = await seed();
    store.exec(`UPDATE video SET also_in_tabs = 'not json' WHERE video_id = '${V1}'`);

    const result = await exportData(store, videos({ channel: CHANNEL }));

    const doc = JSON.parse(read(result.filePath)) as { rows: Record<string, unknown>[] };
    expect(doc.rows.find((row) => row.videoId === V1)).toMatchObject({ alsoInTabs: [] });
  });

  it('says how many rows exist and when the file holds fewer', async () => {
    const store = await seed();

    const result = await exportData(store, videos({ limit: 1 }));

    expect(result).toMatchObject({ rows: 1, total: 3, truncated: true });
    expect(JSON.parse(read(result.filePath))).toMatchObject({ truncated: true, total: 3 });
  });

  it('writes CSV with the receipts in a file beside it, since a CSV cannot hold them', async () => {
    const store = await seed();

    const result = await exportData(store, videos({ channel: CHANNEL, format: 'csv' }));

    const csv = read(result.filePath);
    expect(csv.split('\r\n')[0]).toContain('videoId,channelId,title');
    // A title with a comma and quotes survives intact.
    expect(csv).toContain('"Battery, ""tested"""');
    expect(result.coveragePath).toBeDefined();
    expect(JSON.parse(read(result.coveragePath ?? ''))).toMatchObject({
      dataset: 'videos',
      coverage: [{ scope: 'channel-catalog', complete: true }],
    });
  });

  it('writes Markdown with a completeness section above the table', async () => {
    const store = await seed();

    const result = await exportData(store, videos({ channel: CHANNEL, format: 'markdown' }));

    const text = read(result.filePath);
    expect(text).toContain('# Videos');
    expect(text.indexOf('Completeness')).toBeLessThan(text.indexOf('| videoId'));
    expect(text).toContain(`| ${V1} |`);
  });

  it('refuses a channel id that is not one, before writing anything', async () => {
    const store = await seed();

    await expect(exportData(store, videos({ channel: '../x' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('writes into the default folder under the home directory, to the same path every time', async () => {
    const store = await seed();

    const first = await exportData(store, videos({ channel: CHANNEL }));
    const second = await exportData(store, videos({ channel: CHANNEL }));

    expect(first.filePath.startsWith(home)).toBe(true);
    expect(second.filePath).toBe(first.filePath);
  });
});

describe('exportData comments', () => {
  it('exports a video’s comments with their replies and the time they were posted', async () => {
    const store = await seed();

    const result = await exportData(store, comments({ video: V1 }));

    expect(result).toMatchObject({ dataset: 'comments', rows: 3, total: 3 });
    const doc = JSON.parse(read(result.filePath)) as { rows: Record<string, unknown>[] };
    expect(doc.rows.find((row) => row.commentId === 'c1')).toMatchObject({
      author: 'Alice',
      likeCount: 7,
      publishedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(doc.rows.find((row) => row.commentId === 'c3')).toMatchObject({ parentId: 'c1' });
  });

  it('carries the comment receipt, which says the harvest holds 3 of 10', async () => {
    const store = await seed();

    const result = await exportData(store, comments({ video: V1 }));

    expect(result.coverage).toMatchObject([
      { scope: 'video-comments', targetId: V1, complete: false, have: 3, expected: 10 },
    ]);
  });

  it('defuses a comment that a spreadsheet would run as a formula', async () => {
    const store = await seed();

    const result = await exportData(store, comments({ video: V1, format: 'csv' }));

    const csv = read(result.filePath);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it('keeps comment and author ids exact in a CSV, even when one begins with a dash', async () => {
    const store = await seed();
    store.exec(
      `INSERT INTO comment (comment_id, video_id, text, like_count, author, author_id, harvested_at) VALUES ('-Ugx_dash', '${V2}', 'x', 1, 'A', '-UCauthor', 1)`
    );

    const result = await exportData(store, comments({ video: V2, format: 'csv' }));

    const csv = read(result.filePath);
    expect(csv).toContain('\r\n-Ugx_dash,');
    expect(csv).toContain(',-UCauthor,');
    expect(csv).not.toContain("'-Ugx_dash");
  });

  it('exports a channel’s comments across all its videos', async () => {
    const store = await seed();

    expect((await exportData(store, comments({ channel: CHANNEL }))).rows).toBe(3);
    expect((await exportData(store, comments({ channel: OTHER }))).rows).toBe(0);
  });

  it('pages through more comments than one query returns, without losing or repeating any', async () => {
    const store = await seed();
    const insert = store.prepare(
      `INSERT INTO comment (comment_id, video_id, text, like_count, author, harvested_at) VALUES (?,?,?,?,?,?)`
    );
    store.exec('BEGIN');
    for (let index = 0; index < 2_500; index += 1) {
      insert.run(`bulk${String(index)}`, V2, 'x', index, 'A', 1);
    }
    store.exec('COMMIT');

    const result = await exportData(store, comments({ video: V2, limit: 2_200 }));

    expect(result).toMatchObject({ rows: 2_200, total: 2_500, truncated: true });
    const ids = (JSON.parse(read(result.filePath)) as { rows: { commentId: string }[] }).rows.map(
      (row) => row.commentId
    );
    expect(new Set(ids).size).toBe(2_200);
  });

  it('writes nothing for a request it refuses', async () => {
    const store = await seed();

    await expect(exportData(store, comments({ video: '../x' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(existsSync(join(home, '.youtube-knowledge', 'exports'))).toBe(false);
  });
});
