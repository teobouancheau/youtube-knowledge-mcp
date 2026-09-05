import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCK_STALE_MS, withFileLock } from '../../src/utils/file-lock.js';
import { YouTubeError } from '../../src/utils/errors.js';

/**
 * The race the lock is written for: two callers find the same stale lock, one
 * breaks and re-acquires it first, the other must lose. Simulated by making
 * the stale lock's removal a no-op, so the loser's second acquire fails.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(actual.rm),
  };
});

import { rm as rmMock } from 'node:fs/promises';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'file-lock-race-'));
  vi.mocked(rmMock).mockClear();
});

afterEach(async () => {
  vi.mocked(rmMock).mockRestore();
  await rm(directory, { recursive: true, force: true });
});

const held = (existing: { pid: number } | undefined): YouTubeError =>
  new YouTubeError('INVALID_INPUT', existing === undefined ? 'lost the race' : 'busy');

describe('withFileLock under contention', () => {
  it('reports losing the race when another caller re-acquired a broken lock first', async () => {
    const lock = join(directory, 'job.lock');
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString();
    await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: old }));
    // The stale lock is "removed" but stays on disk, as if the other caller had
    // already written a fresh one in its place.
    vi.mocked(rmMock).mockResolvedValueOnce(undefined);

    await expect(withFileLock(lock, () => Promise.resolve(1), held)).rejects.toMatchObject({
      message: 'lost the race',
    });
  });

  it('propagates a failure to create the lock that is not "already exists"', async () => {
    const lock = join(directory, 'missing-directory', 'job.lock');

    await expect(withFileLock(lock, () => Promise.resolve(1), held)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
