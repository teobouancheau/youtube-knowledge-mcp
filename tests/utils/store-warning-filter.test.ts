import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

import { closeStore, getStore } from '../../src/utils/store.js';

/**
 * Its own file because the filter installs once per process, so the listener
 * has to be in place before the very first store open — which a shared file
 * would make order-dependent.
 */
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-warn-'));
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
});

describe('the SQLite experimental warning filter', () => {
  it('drops Node’s SQLite notice while re-emitting every other warning', async () => {
    const seen: string[] = [];
    const listener = (warning: Error): void => {
      seen.push(warning.message);
    };
    process.on('warning', listener);

    await getStore();

    process.emit(
      'warning',
      Object.assign(new Error('SQLite is an experimental feature'), { name: 'ExperimentalWarning' })
    );
    process.emit(
      'warning',
      Object.assign(new Error('something else entirely'), { name: 'ExperimentalWarning' })
    );
    process.emit(
      'warning',
      Object.assign(new Error('a deprecation'), { name: 'DeprecationWarning' })
    );

    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener('warning', listener);

    expect(seen).toEqual(['something else entirely', 'a deprecation']);
  });
});
