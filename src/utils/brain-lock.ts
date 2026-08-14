import { rm, writeFile } from 'node:fs/promises';
import { brainLockSchema } from '../brain-schemas.js';
import { ensureBrainDir } from './brain-storage.js';
import { lockPath } from './brain-paths.js';
import { YouTubeError } from './errors.js';
import { readJsonFile } from './json-file.js';
import { isRecord } from './ytdlp.js';

/**
 * Exclusive access to a brain while it is being built.
 *
 * Two builds of one channel would interleave their manifest checkpoints, and
 * the later write would silently drop whatever the other had recorded since it
 * last read. A lock file rather than an in-process mutex because a second
 * server process — a second editor window, a stray `npm start` — is the case
 * that actually happens.
 */

/** Long enough that a slow build is never mistaken for a dead one. */
export const LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * Run `build` holding the lock.
 *
 * It is released on any exit, including cancellation. A process killed outright
 * leaves one behind, which is why a lock is also broken when its owner is gone
 * or when it is simply too old to be real.
 */
export async function withBuildLock<T>(channelId: string, build: () => Promise<T>): Promise<T> {
  await ensureBrainDir(channelId);
  const path = lockPath(channelId);

  if (!(await acquire(path))) {
    const existing = await readJsonFile(path, brainLockSchema);

    // An unreadable lock is one being written this instant, which is as held as
    // it gets. Only a lock whose owner is demonstrably gone gets broken.
    if (existing === undefined || !isStale(existing.pid, existing.startedAt)) {
      throw alreadyRunning(channelId, existing);
    }

    await rm(path, { force: true });

    // Losing this second race means another caller broke the same stale lock
    // first, and is now the legitimate owner.
    if (!(await acquire(path))) throw alreadyRunning(channelId, undefined);
  }

  try {
    return await build();
  } finally {
    await rm(path, { force: true });
  }
}

function alreadyRunning(
  channelId: string,
  existing: { pid: number; startedAt: string } | undefined
): YouTubeError {
  const owner =
    existing === undefined ? '' : `Started at ${existing.startedAt} by process ${existing.pid}. `;

  return new YouTubeError('INVALID_INPUT', `A build for ${channelId} is already running.`, {
    nextStep: `${owner}Wait for it to finish, then call build_brain again to continue where it stopped.`,
  });
}

/**
 * Create the lock file, or report that someone else already has.
 *
 * `wx` fails when the file exists, and that check and the creation are one
 * operation in the kernel. Reading first and writing after is not a lock: two
 * builds starting together both see nothing and both proceed.
 */
async function acquire(path: string): Promise<boolean> {
  const lock = { pid: process.pid, startedAt: new Date().toISOString() };

  try {
    await writeFile(path, JSON.stringify(lock), { encoding: 'utf-8', flag: 'wx' });
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') return false;
    throw error;
  }
}

function isStale(pid: number, startedAt: string): boolean {
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
    return isRecord(error) && error.code === 'EPERM';
  }
}
