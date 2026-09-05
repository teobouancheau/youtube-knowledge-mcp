import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCK_STALE_MS, withFileLock } from '../../src/utils/file-lock.js';
import { YouTubeError } from '../../src/utils/errors.js';

let directory: string;
let lock: string;

const held = (): YouTubeError => new YouTubeError('INVALID_INPUT', 'busy');

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'file-lock-'));
  lock = join(directory, 'job.lock');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('withFileLock', () => {
  it('holds the lock while working and releases it afterwards', async () => {
    let seen = false;
    await withFileLock(
      lock,
      async () => {
        seen = existsSync(lock);
        expect(JSON.parse(await readFile(lock, 'utf-8'))).toMatchObject({ pid: process.pid });
      },
      held
    );
    expect(seen).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('releases the lock when the work throws', async () => {
    await expect(withFileLock(lock, () => Promise.reject(new Error('boom')), held)).rejects.toThrow(
      'boom'
    );
    expect(existsSync(lock)).toBe(false);
  });

  it('refuses while a live lock is held, with the caller-supplied error', async () => {
    await writeFile(
      lock,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );

    await expect(withFileLock(lock, () => Promise.resolve(1), held)).rejects.toMatchObject({
      message: 'busy',
    });
  });

  it('treats an unreadable lock as held', async () => {
    await writeFile(lock, 'not json');

    await expect(withFileLock(lock, () => Promise.resolve(1), held)).rejects.toMatchObject({
      message: 'busy',
    });
  });

  it('breaks a lock that is older than the staleness limit', async () => {
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString();
    await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: old }));

    await expect(withFileLock(lock, () => Promise.resolve(42), held)).resolves.toBe(42);
  });

  it('breaks a lock whose owner is gone', async () => {
    await writeFile(
      lock,
      JSON.stringify({ pid: 2 ** 22 - 1, startedAt: new Date().toISOString() })
    );

    await expect(withFileLock(lock, () => Promise.resolve(42), held)).resolves.toBe(42);
  });

  it('breaks a lock with an unparseable start time', async () => {
    await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: 'yesterday' }));

    await expect(withFileLock(lock, () => Promise.resolve(42), held)).resolves.toBe(42);
  });
});
