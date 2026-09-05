import { rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { YouTubeError } from './errors.js';
import { readJsonFile } from './json-file.js';

/**
 * Exclusive access to a directory's contents while a long job writes them.
 *
 * Two jobs on one channel would interleave their checkpoints, and the later
 * write would silently drop whatever the other had recorded since it last
 * read. A lock file rather than an in-process mutex because a second server
 * process — a second editor window, a stray `npm start` — is the case that
 * actually happens.
 */

/** Long enough that a slow job is never mistaken for a dead one. */
export const LOCK_STALE_MS = 30 * 60 * 1000;

export const lockRecordSchema = z.object({
  pid: z.number().int(),
  startedAt: z.string(),
});

export type LockRecord = z.infer<typeof lockRecordSchema>;

/**
 * Run `work` holding the lock at `path`.
 *
 * It is released on any exit, including cancellation. A process killed outright
 * leaves one behind, which is why a lock is also broken when its owner is gone
 * or when it is simply too old to be real. `held` builds the error to throw
 * when someone else genuinely has it, so each caller can name its own tool.
 */
export async function withFileLock<T>(
  path: string,
  work: () => Promise<T>,
  held: (existing: LockRecord | undefined) => YouTubeError
): Promise<T> {
  if (!(await acquire(path))) {
    const existing = await readJsonFile(path, lockRecordSchema);

    // An unreadable lock is one being written this instant, which is as held as
    // it gets. Only a lock whose owner is demonstrably gone gets broken.
    if (existing === undefined || !isStale(existing)) throw held(existing);

    await rm(path, { force: true });

    // Losing this second race means another caller broke the same stale lock
    // first, and is now the legitimate owner.
    if (!(await acquire(path))) throw held(undefined);
  }

  try {
    return await work();
  } finally {
    await rm(path, { force: true });
  }
}

/**
 * Create the lock file, or report that someone else already has.
 *
 * `wx` fails when the file exists, and that check and the creation are one
 * operation in the kernel. Reading first and writing after is not a lock: two
 * jobs starting together both see nothing and both proceed.
 */
async function acquire(path: string): Promise<boolean> {
  const lock: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() };

  try {
    await writeFile(path, JSON.stringify(lock), { encoding: 'utf-8', flag: 'wx' });
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
}

function isStale({ pid, startedAt }: LockRecord): boolean {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started) || Date.now() - started > LOCK_STALE_MS) return true;

  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user, which for
    // this purpose is very much alive.
    return errorCode(error) === 'EPERM';
  }
}

/** The `code` a Node system error carries, when it is one. */
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}
