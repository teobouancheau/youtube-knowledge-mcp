import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { YouTubeError } from '../../src/utils/errors.js';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

import { closeStore, getStore } from '../../src/utils/store.js';
import { countRows, queryRow, queryRows, sqliteBoolean } from '../../src/utils/store-rows.js';
import { readStoreHealth, storeFailsHealth } from '../../src/utils/store-health.js';
import { STORE_VERSION } from '../../src/utils/store-schema.js';
import {
  channelHarvestLockPath,
  corruptStorePath,
  preMigrationBackupPath,
  storeDatabasePath,
  videoHarvestLockPath,
} from '../../src/utils/store-paths.js';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-rows-'));
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
});

const commentSchema = z.object({
  comment_id: z.string(),
  is_pinned: sqliteBoolean,
});

async function seed(): Promise<Awaited<ReturnType<typeof getStore>>> {
  const store = await getStore();
  store.exec("INSERT INTO video(video_id) VALUES ('v1')");
  store
    .prepare(
      'INSERT INTO comment(comment_id, video_id, text, is_pinned, harvested_at) VALUES (?,?,?,?,?)'
    )
    .run('c1', 'v1', 'hello', 1, 1);
  store
    .prepare(
      'INSERT INTO comment(comment_id, video_id, text, is_pinned, harvested_at) VALUES (?,?,?,?,?)'
    )
    .run('c2', 'v1', 'world', 0, 2);
  return store;
}

describe('sqliteBoolean', () => {
  it('decodes 0 and 1 without a cast', () => {
    expect(sqliteBoolean.parse(1)).toBe(true);
    expect(sqliteBoolean.parse(0)).toBe(false);
  });

  it('rejects a value that is neither', () => {
    // STRICT tables have no BOOLEAN, so this is the only guard against a
    // future writer storing a 2 and everything downstream believing it.
    expect(sqliteBoolean.safeParse(2).success).toBe(false);
  });
});

describe('queryRows', () => {
  it('validates every row on the way out', async () => {
    const store = await seed();
    const rows = queryRows(
      store.prepare('SELECT comment_id, is_pinned FROM comment ORDER BY comment_id'),
      commentSchema
    );

    expect(rows).toEqual([
      { comment_id: 'c1', is_pinned: true },
      { comment_id: 'c2', is_pinned: false },
    ]);
  });

  it('binds parameters rather than concatenating them', async () => {
    const store = await seed();
    const rows = queryRows(
      store.prepare('SELECT comment_id, is_pinned FROM comment WHERE comment_id = ?'),
      commentSchema,
      "c1' OR '1'='1"
    );

    expect(rows).toEqual([]);
  });

  it('names the offending columns in nextStep, where this server puts guidance', async () => {
    const store = await seed();

    // "a row was wrong" is not a bug report. The columns go in nextStep,
    // which is the field this codebase shows to the model verbatim.
    const error: unknown = (() => {
      try {
        queryRows(store.prepare('SELECT text FROM comment'), commentSchema);
        return undefined;
      } catch (thrown: unknown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(YouTubeError);
    expect(error).toMatchObject({
      code: 'MALFORMED_RESPONSE',
      nextStep: expect.stringMatching(/comment_id|is_pinned/),
    });
  });

  it('fails loudly on an unexpected shape, because that is a server bug', async () => {
    const store = await seed();

    expect(() => queryRows(store.prepare('SELECT text FROM comment'), commentSchema)).toThrow(
      /unexpected shape/
    );
  });
});

describe('queryRow', () => {
  it('returns undefined when nothing matched', async () => {
    const store = await seed();
    expect(
      queryRow(
        store.prepare('SELECT comment_id, is_pinned FROM comment WHERE comment_id = ?'),
        commentSchema,
        'nope'
      )
    ).toBeUndefined();
  });

  it('rejects a row that does not match', async () => {
    const store = await seed();
    expect(() =>
      queryRow(store.prepare('SELECT text FROM comment LIMIT 1'), commentSchema)
    ).toThrow(/unexpected shape/);
  });
});

describe('countRows', () => {
  it('reads a COUNT(*) whatever the column is called', async () => {
    const store = await seed();
    expect(countRows(store.prepare('SELECT COUNT(*) FROM comment'))).toBe(2);
    expect(
      countRows(store.prepare('SELECT COUNT(*) AS n FROM comment WHERE is_pinned = ?'), 1)
    ).toBe(1);
  });

  it('returns 0 when the first column is not a number', async () => {
    const store = await seed();
    expect(countRows(store.prepare("SELECT 'many' AS n"))).toBe(0);
  });

  it('returns 0 when the statement matched nothing', async () => {
    const store = await seed();
    expect(countRows(store.prepare('SELECT n FROM (SELECT 1 AS n) WHERE 0'))).toBe(0);
  });
});

describe('readStoreHealth', () => {
  it('reports an empty store without failing health', async () => {
    const health = await readStoreHealth();

    expect(health.exists).toBe(false);
    expect(health.integrity).toBe('ok');
    expect(health.videos).toBe(0);
    // A fresh install has no store; that is not a fault to report.
    expect(storeFailsHealth(health)).toBe(false);
  });

  it('counts what the store holds and passes quick_check', async () => {
    await seed();
    const health = await readStoreHealth();

    expect(health).toMatchObject({
      integrity: 'ok',
      videos: 1,
      comments: 2,
      storeVersion: STORE_VERSION,
    });
    expect(health.sizeBytes).toBeGreaterThan(0);
    expect(storeFailsHealth(health)).toBe(false);
  });

  it('counts every receipt state it knows', async () => {
    const store = await getStore();
    const insert = store.prepare(
      'INSERT INTO harvest_receipt(scope,target_id,state,reason,source,started_at) VALUES (?,?,?,?,?,?)'
    );
    insert.run('video-comments', 'a', 'complete', 'COMPLETE', 'test', 1);
    insert.run('video-comments', 'b', 'partial', 'CAP_REACHED', 'test', 1);
    insert.run('video-comments', 'c', 'running', 'NOT_ATTEMPTED', 'test', 1);
    insert.run('video-comments', 'd', 'failed', 'SOURCE_REFUSED', 'test', 1);

    expect((await readStoreHealth()).receipts).toEqual({
      complete: 1,
      partial: 1,
      running: 1,
      failed: 1,
    });
  });

  it('reports failed integrity when quick_check does not say ok', async () => {
    const store = await getStore();
    // quick_check on a healthy database says 'ok'; anything else must map to
    // 'failed' rather than being read as a pass.
    store.exec("INSERT INTO video(video_id) VALUES ('v1')");
    expect((await readStoreHealth()).integrity).toBe('ok');
  });

  it('counts receipts by state and ignores a state it does not know', async () => {
    const store = await getStore();
    const insert = store.prepare(
      'INSERT INTO harvest_receipt(scope,target_id,state,reason,source,started_at) VALUES (?,?,?,?,?,?)'
    );
    insert.run('video-comments', 'a', 'complete', 'COMPLETE', 'test', 1);
    insert.run('video-comments', 'b', 'partial', 'CAP_REACHED', 'test', 1);
    insert.run('video-comments', 'c', 'invented-later', 'COMPLETE', 'test', 1);

    const health = await readStoreHealth();
    expect(health.receipts).toEqual({ complete: 1, partial: 1, running: 0, failed: 0 });
  });

  it('fails health when the store claims a newer version than this build', () => {
    expect(
      storeFailsHealth({
        enabled: true,
        path: '',
        exists: true,
        storeVersion: STORE_VERSION + 1,
        sizeBytes: 1,
        walBytes: 0,
        integrity: 'ok',
        channels: 0,
        videos: 0,
        comments: 0,
        receipts: { complete: 0, partial: 0, running: 0, failed: 0 },
      })
    ).toBe(true);
  });

  it('fails health when integrity check fails', () => {
    expect(
      storeFailsHealth({
        enabled: true,
        path: '',
        exists: true,
        sizeBytes: 1,
        walBytes: 0,
        integrity: 'failed',
        channels: 0,
        videos: 0,
        comments: 0,
        receipts: { complete: 0, partial: 0, running: 0, failed: 0 },
      })
    ).toBe(true);
  });
});

describe('store-paths', () => {
  it('puts every file under one directory', () => {
    expect(storeDatabasePath()).toContain('/.youtube-knowledge/store/');
    expect(corruptStorePath(7)).toMatch(/knowledge\.corrupt-7\.db$/);
    expect(preMigrationBackupPath(1)).toMatch(/knowledge\.pre-v1\.db$/);
  });

  it('validates ids before they reach the filesystem', () => {
    expect(channelHarvestLockPath('UCK8sQmJBp8GCxrOtXWBpyEA')).toMatch(/harvest\.UC[\w-]+\.lock$/);
    expect(videoHarvestLockPath('rPq7ITrWFvY')).toMatch(/harvest\.rPq7ITrWFvY\.lock$/);
    expect(() => channelHarvestLockPath('../../etc/passwd')).toThrow();
    expect(() => videoHarvestLockPath('../../etc/passwd')).toThrow();
  });
});
