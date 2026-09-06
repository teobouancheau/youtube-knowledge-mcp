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

vi.mock('../../src/utils/youtube-video.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/youtube-video.js')>();
  return { ...actual, getComments: vi.fn(), getVideoDetails: vi.fn() };
});

import { getComments, getVideoDetails } from '../../src/utils/youtube-video.js';
import { toThreads } from '../../src/utils/comment-threads.js';
import { closeStore, getStore } from '../../src/utils/store.js';
import { harvestCommentsHandler } from '../../src/tools/harvest-comments.js';
import { queryCommentsHandler } from '../../src/tools/query-comments.js';

const VIDEO = 'dQw4w9WgXcQ';

const ARGS = { video: VIDEO, maxComments: 5_000, sort: 'new' as const, maxRepliesPerThread: 100 };
const QUERY = { minLikes: 0, topLevelOnly: false, order: 'likes' as const, limit: 25, offset: 0 };

function extraction(
  rows: Parameters<typeof toThreads>[0],
  overrides: Record<string, unknown> = {}
): Awaited<ReturnType<typeof getComments>> {
  const threaded = toThreads(rows);
  return {
    ...threaded,
    ranToExhaustion: true,
    commentsDisabled: false,
    extractedTotal: rows.length,
    ...overrides,
  };
}

const ROWS = [
  {
    id: 'c1',
    parent: 'root',
    author: 'Alice',
    text: 'the camera is great',
    like_count: 50,
    timestamp: 100,
  },
  {
    id: 'c1.1',
    parent: 'c1',
    author: 'Bob',
    text: 'agreed about the camera',
    like_count: 2,
    timestamp: 200,
  },
  {
    id: 'c2',
    parent: 'root',
    author: 'Carol',
    text: 'battery life is poor',
    like_count: 9,
    timestamp: 300,
  },
];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-charvest-'));
  vi.mocked(getVideoDetails).mockResolvedValue({
    uploadDate: '2026-01-01',
    durationSeconds: 60,
    chapters: [],
    commentCount: 3,
  });
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('harvest_comments', () => {
  it('stores replies as well as top-level comments', async () => {
    vi.mocked(getComments).mockResolvedValue(extraction(ROWS));

    const structured = structuredOf(await harvestCommentsHandler(ARGS));

    expect(structured).toMatchObject({
      videoId: VIDEO,
      added: 3,
      topLevel: 2,
      replies: 1,
      coverage: { complete: true, reason: 'COMPLETE' },
    });
  });

  it('re-running upserts rather than duplicating', async () => {
    vi.mocked(getComments).mockResolvedValue(extraction(ROWS));
    await harvestCommentsHandler(ARGS);

    // A like count moves between runs; the row is updated, not doubled.
    vi.mocked(getComments).mockResolvedValue(
      extraction([{ ...ROWS[0], like_count: 99 }, ...ROWS.slice(1)] as typeof ROWS)
    );
    const second = structuredOf(await harvestCommentsHandler(ARGS));

    expect(second).toMatchObject({ added: 3 });
    const store = await getStore();
    expect(
      store.prepare('SELECT like_count FROM comment WHERE comment_id = ?').get('c1')?.like_count
    ).toBe(99);
  });

  it('does not claim completeness when the cap bound', async () => {
    vi.mocked(getComments).mockResolvedValue(extraction(ROWS, { extractedTotal: 3 }));

    const result = await harvestCommentsHandler({ ...ARGS, maxComments: 3 });

    expect(structuredOf(result)).toMatchObject({
      coverage: { complete: false, reason: 'CAP_REACHED', limitApplied: 3 },
    });
    expect(textOf(result)).toContain('no comment cursor');
  });

  it('writes the rows and the receipt in one transaction', async () => {
    vi.mocked(getComments).mockResolvedValue(extraction(ROWS));
    await harvestCommentsHandler(ARGS);

    const store = await getStore();
    const receipt = store
      .prepare('SELECT have FROM harvest_receipt WHERE target_id = ?')
      .get(VIDEO);

    // The receipt's number and the store's count cannot disagree, because
    // nothing can commit one without the other.
    expect(receipt?.have).toBe(3);
    expect(store.prepare('SELECT COUNT(*) AS n FROM comment').get()?.n).toBe(3);
  });

  it('records comments-disabled as complete at zero', async () => {
    vi.mocked(getComments).mockResolvedValue({
      threads: [],
      rootCount: 0,
      replyCount: 0,
      orphanCount: 0,
      ranToExhaustion: false,
      commentsDisabled: true,
      extractedTotal: 0,
    });

    expect(structuredOf(await harvestCommentsHandler(ARGS))).toMatchObject({
      coverage: { complete: true, expected: 0, reason: 'COMPLETE' },
    });
  });
});

describe('query_comments', () => {
  beforeEach(async () => {
    vi.mocked(getComments).mockResolvedValue(extraction(ROWS));
    await harvestCommentsHandler(ARGS);
  });

  it('finds comments by full text', async () => {
    const structured = structuredOf(await queryCommentsHandler({ ...QUERY, match: 'camera' }));

    expect(structured).toMatchObject({ total: 2 });
    expect(JSON.stringify(structured.comments)).toContain('Alice');
    expect(JSON.stringify(structured.comments)).not.toContain('battery');
  });

  it('pages honestly, because the dataset is local and fixed', async () => {
    const first = structuredOf(await queryCommentsHandler({ ...QUERY, limit: 1 }));

    expect(first).toMatchObject({ total: 3, count: 1, hasMore: true, nextOffset: 1 });
  });

  it('returns a thread in reply order', async () => {
    const structured = structuredOf(await queryCommentsHandler({ ...QUERY, threadOf: 'c1' }));
    const ids = JSON.parse(JSON.stringify(structured.comments)) as { id: string }[];

    expect(ids.map((row) => row.id)).toEqual(['c1', 'c1.1']);
  });

  it('filters to top-level comments only', async () => {
    expect(
      structuredOf(await queryCommentsHandler({ ...QUERY, topLevelOnly: true }))
    ).toMatchObject({
      total: 2,
    });
  });

  it('carries the coverage of the videos the rows came from', async () => {
    const structured = structuredOf(await queryCommentsHandler(QUERY));

    // total is rows in the store; the receipts are what stop that being read
    // as the number of comments the video has.
    expect(JSON.stringify(structured.coverage)).toContain('"scope":"video-comments"');
  });

  it('warns when the videos behind the results are only partly harvested', async () => {
    vi.mocked(getComments).mockResolvedValue(extraction(ROWS, { extractedTotal: 3 }));
    await harvestCommentsHandler({ ...ARGS, maxComments: 3 });

    expect(textOf(await queryCommentsHandler(QUERY))).toContain('not all of them');
  });

  it('treats a search term as data, never as SQL', async () => {
    const structured = structuredOf(
      await queryCommentsHandler({ ...QUERY, match: '"camera" OR "battery"' })
    );

    expect(structured).toMatchObject({ total: 3 });
  });
});
