import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

import {
  closeStore,
  getStore,
  inTransaction,
  quarantineStore,
  readUserVersion,
  writeUserVersion,
} from '../../src/utils/store.js';
import { storeDatabasePath, storeDir, corruptStorePath } from '../../src/utils/store-paths.js';
import { STORE_VERSION } from '../../src/utils/store-schema.js';
import { runStoreMigrations } from '../../src/utils/store-migrations.js';
import { YouTubeError } from '../../src/utils/errors.js';

/**
 * Real databases, not mocks. 200k rows insert in under a second, so a fixture
 * costs less than the indirection would — and it means the SQL itself is
 * covered rather than a stand-in for it.
 */
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-store-'));
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
});

describe('getStore', () => {
  it('creates the schema, stamps the version, and enables WAL', async () => {
    const store = await getStore();

    expect(readUserVersion(store)).toBe(STORE_VERSION);
    expect(store.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(store.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  });

  it('creates every table the harvest needs, including the FTS index', async () => {
    const store = await getStore();
    const names = store
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((row) => row.name);

    for (const table of [
      'channel',
      'video',
      'comment',
      'comment_fts',
      'harvest_receipt',
      'harvest_event',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('keeps the FTS index in step with comments through insert, update and delete', async () => {
    const store = await getStore();
    const matches = (): number =>
      Number(
        store
          .prepare("SELECT COUNT(*) AS n FROM comment_fts WHERE comment_fts MATCH 'kestrel'")
          .get()?.n
      );

    store.exec("INSERT INTO video(video_id) VALUES ('v1')");
    store
      .prepare('INSERT INTO comment(comment_id, video_id, text, harvested_at) VALUES (?,?,?,?)')
      .run('c1', 'v1', 'a kestrel appears', 1);
    expect(matches()).toBe(1);

    store.prepare('UPDATE comment SET text = ? WHERE comment_id = ?').run('a heron appears', 'c1');
    expect(matches()).toBe(0);

    store.prepare('UPDATE comment SET text = ? WHERE comment_id = ?').run('kestrel again', 'c1');
    expect(matches()).toBe(1);

    store.prepare('DELETE FROM comment WHERE comment_id = ?').run('c1');
    expect(matches()).toBe(0);
  });

  it('stores the database readable by its owner only', async () => {
    await getStore();
    expect(statSync(storeDatabasePath()).mode & 0o777).toBe(0o600);
    expect(statSync(storeDir()).mode & 0o777).toBe(0o700);
  });

  it('reuses one connection across calls', async () => {
    expect(await getStore()).toBe(await getStore());
  });

  it('refuses a store written by a newer server rather than touching it', async () => {
    const store = await getStore();
    writeUserVersion(store, STORE_VERSION + 1);
    closeStore();

    await expect(getStore()).rejects.toMatchObject({ code: 'STORE_CORRUPT' });
  });

  it('reports a file that is not a database as STORE_CORRUPT, not a raw sqlite error', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(storeDir(), { recursive: true, mode: 0o700 });
    writeFileSync(storeDatabasePath(), 'this is not a database');

    const error: unknown = await getStore().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(YouTubeError);
    expect(error).toMatchObject({ code: 'STORE_CORRUPT' });
  });
});

describe('inTransaction', () => {
  it('rolls back every write when the work throws', async () => {
    const store = await getStore();
    store.exec("INSERT INTO video(video_id) VALUES ('v1')");

    expect(() =>
      inTransaction(store, () => {
        store
          .prepare('INSERT INTO comment(comment_id, video_id, text, harvested_at) VALUES (?,?,?,?)')
          .run('c1', 'v1', 'kept?', 1);
        throw new Error('interrupted');
      })
    ).toThrow('interrupted');

    // This is the property that makes a receipt trustworthy: rows and the
    // receipt describing them either both land or neither does.
    expect(store.prepare('SELECT COUNT(*) AS n FROM comment').get()?.n).toBe(0);
  });

  it('returns the work result on success', async () => {
    const store = await getStore();
    expect(inTransaction(store, () => 42)).toBe(42);
  });
});

describe('quarantineStore', () => {
  it('renames the damaged file rather than deleting it', async () => {
    await getStore();
    const moved = await quarantineStore(1234);

    expect(moved).toBe(corruptStorePath(1234));
    expect(statSync(moved).size).toBeGreaterThan(0);

    // Re-opening starts a clean store, so the next harvest is not blocked.
    expect(readUserVersion(await getStore())).toBe(STORE_VERSION);
  });
});

describe('runStoreMigrations', () => {
  it('stamps a fresh database at the current version', async () => {
    const store = await getStore();
    writeUserVersion(store, 0);

    expect(runStoreMigrations(store, 0)).toBe(STORE_VERSION);
    expect(readUserVersion(store)).toBe(STORE_VERSION);
  });

  it('leaves an already-current database alone', async () => {
    const store = await getStore();
    expect(runStoreMigrations(store, STORE_VERSION)).toBe(STORE_VERSION);
  });
});
