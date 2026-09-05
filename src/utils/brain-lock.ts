import { ensureBrainDir } from './brain-storage.js';
import { lockPath } from './brain-paths.js';
import { YouTubeError } from './errors.js';
import { withFileLock, type LockRecord } from './file-lock.js';

export { LOCK_STALE_MS } from './file-lock.js';

/** Exclusive access to a brain while it is being built. See `withFileLock`. */
export async function withBuildLock<T>(channelId: string, build: () => Promise<T>): Promise<T> {
  await ensureBrainDir(channelId);
  return withFileLock(lockPath(channelId), build, (existing) =>
    alreadyRunning(channelId, existing)
  );
}

function alreadyRunning(channelId: string, existing: LockRecord | undefined): YouTubeError {
  const owner =
    existing === undefined ? '' : `Started at ${existing.startedAt} by process ${existing.pid}. `;

  return new YouTubeError('INVALID_INPUT', `A build for ${channelId} is already running.`, {
    nextStep: `${owner}Wait for it to finish, then call build_brain again to continue where it stopped.`,
  });
}
