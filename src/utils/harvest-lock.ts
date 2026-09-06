import { YouTubeError } from './errors.js';
import { ensurePrivateDir } from './paths.js';
import { withFileLock, type LockRecord } from './file-lock.js';
import { channelHarvestLockPath, storeDir, videoHarvestLockPath } from './store-paths.js';

/**
 * Exclusive access to one harvest target.
 *
 * WAL already keeps concurrent writes consistent, so this is not about the
 * rows. It is about the requests: two harvests of the same channel would each
 * spawn yt-dlp and double the rate at the one resource that throttles us.
 */

function alreadyRunning(what: string, id: string, existing: LockRecord | undefined): YouTubeError {
  const owner =
    existing === undefined ? '' : `Started at ${existing.startedAt} by process ${existing.pid}. `;

  return new YouTubeError('INVALID_INPUT', `A harvest of ${what} ${id} is already running.`, {
    nextStep: `${owner}Wait for it to finish, then call the tool again to continue where it stopped.`,
  });
}

export async function withChannelHarvestLock<T>(
  channelId: string,
  work: () => Promise<T>
): Promise<T> {
  await ensurePrivateDir(storeDir());
  return withFileLock(channelHarvestLockPath(channelId), work, (existing) =>
    alreadyRunning('channel', channelId, existing)
  );
}

export async function withVideoHarvestLock<T>(videoId: string, work: () => Promise<T>): Promise<T> {
  await ensurePrivateDir(storeDir());
  return withFileLock(videoHarvestLockPath(videoId), work, (existing) =>
    alreadyRunning('video', videoId, existing)
  );
}
