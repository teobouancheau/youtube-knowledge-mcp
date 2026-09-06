import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { textOf, structuredOf } from '../helpers.js';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

import { closeStore, getStore } from '../../src/utils/store.js';
import { storeDatabasePath, storeDir } from '../../src/utils/store-paths.js';
import { repairStoreHandler } from '../../src/tools/repair-store.js';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-repair-'));
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
});

describe('repairStoreHandler', () => {
  it('leaves a healthy store alone', async () => {
    const store = await getStore();
    store.exec("INSERT INTO video(video_id) VALUES ('v1')");

    const result = await repairStoreHandler();

    expect(textOf(result)).toContain('Nothing to repair');
    expect(structuredOf(result)).toMatchObject({ wasCorrupt: false, integrity: 'ok' });
    expect(existsSync(storeDatabasePath())).toBe(true);
  });

  it('moves an unreadable store aside and keeps it', async () => {
    mkdirSync(storeDir(), { recursive: true, mode: 0o700 });
    writeFileSync(storeDatabasePath(), 'not a database');

    const result = await repairStoreHandler();
    const structured = structuredOf(result);

    expect(structured).toMatchObject({ wasCorrupt: true });
    // The damaged file is renamed, never deleted: a harvest costs hours of
    // network that no local cache can replay.
    const movedTo = z.string().parse(structured.movedTo);
    expect(existsSync(movedTo)).toBe(true);
    expect(textOf(result)).toContain('was kept, not deleted');
  });

  it('leaves a working store behind after a repair', async () => {
    mkdirSync(storeDir(), { recursive: true, mode: 0o700 });
    writeFileSync(storeDatabasePath(), 'not a database');
    await repairStoreHandler();

    const store = await getStore();
    expect(store.prepare('SELECT COUNT(*) AS n FROM comment').get()?.n).toBe(0);
  });
});
