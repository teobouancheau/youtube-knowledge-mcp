import { join } from 'node:path';
import { dataDir } from './paths.js';
import { assertChannelId, assertVideoId } from './validate.js';

/**
 * Every file the harvested store is made of.
 *
 * The only module that names `dataDir('store')`, so a later decision to shard
 * the database by channel touches one file rather than every caller — the same
 * reason `brain-paths.ts` exists.
 *
 * The `-wal` and `-shm` sidecars are created and removed by SQLite itself, not
 * by us. They are the one place in this codebase where a file under the data
 * directory is not written through `writeJsonAtomic`, and that exception is
 * confined to the `store*.ts` modules.
 */

export function storeDir(): string {
  return dataDir('store');
}

export function storeDatabasePath(): string {
  return join(storeDir(), 'knowledge.db');
}

/**
 * Where a database that failed its integrity check is moved to.
 *
 * Renamed rather than deleted: a harvest costs hours of network that no local
 * cache can replay, so nothing here removes one without the user asking.
 */
export function corruptStorePath(at: number): string {
  return join(storeDir(), `knowledge.corrupt-${String(at)}.db`);
}

/** Taken before a migration that would change an existing `user_version`. */
export function preMigrationBackupPath(fromVersion: number): string {
  return join(storeDir(), `knowledge.pre-v${String(fromVersion)}.db`);
}

/**
 * Job-level exclusion, which WAL does not provide.
 *
 * WAL keeps concurrent writes consistent; it does not stop two harvests of the
 * same channel from spawning yt-dlp twice and doubling the request rate at the
 * one thing that throttles us.
 */
export function channelHarvestLockPath(channelId: string): string {
  return join(storeDir(), `harvest.${assertChannelId(channelId)}.lock`);
}

export function videoHarvestLockPath(videoId: string): string {
  return join(storeDir(), `harvest.${assertVideoId(videoId)}.lock`);
}
