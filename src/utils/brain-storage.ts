import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brainLockSchema, brainManifestSchema, type BrainManifest } from '../brain-schemas.js';
import { YouTubeError } from './errors.js';
import { readJsonFile, writeJsonAtomic } from './json-file.js';
import { brainDir, brainsDir, lockPath, manifestPath, profilePath } from './brain-paths.js';
import { isRecord } from './ytdlp.js';
import { forgetBrainCorpus } from './brain-index.js';

/**
 * What a brain records about itself, and who is allowed to be writing it.
 *
 * The manifest is the brain's account of its own construction: which videos it
 * covers, which it could not read, and where a build stopped. Everything that
 * makes a build resumable is here rather than inferred from what happens to be
 * on disk.
 */

export const BRAIN_MANIFEST_VERSION = 1;

/** Long enough that a slow build is never mistaken for a dead one. */
export const LOCK_STALE_MS = 30 * 60 * 1000;

export async function ensureBrainDir(channelId: string): Promise<string> {
  const directory = brainDir(channelId);
  await mkdir(directory, { recursive: true });
  return directory;
}

// -- Manifest ------------------------------------------------------------

export async function readManifest(channelId: string): Promise<BrainManifest | undefined> {
  return readJsonFile(manifestPath(channelId), brainManifestSchema);
}

/**
 * The manifest, or a typed failure naming the tool that would create it.
 *
 * Most callers want this rather than `readManifest`: "there is no brain yet" is
 * the single most likely reason a brain tool cannot do its job, and the model
 * needs to be told what to call, not handed an undefined.
 */
export async function requireManifest(channelId: string): Promise<BrainManifest> {
  const manifest = await readManifest(channelId);

  if (manifest === undefined) {
    throw new YouTubeError('NOT_FOUND', `No brain has been built for channel ${channelId}.`, {
      nextStep:
        'Call build_brain with the channel URL or handle, or list_brains to see what exists.',
    });
  }

  return manifest;
}

export async function writeManifest(manifest: BrainManifest): Promise<void> {
  await ensureBrainDir(manifest.channel.channelId);
  await writeJsonAtomic(manifestPath(manifest.channel.channelId), manifest);
}

/** Every brain on disk, newest first. Unreadable directories are skipped. */
export async function listManifests(): Promise<BrainManifest[]> {
  if (!existsSync(brainsDir())) return [];

  const entries = await readdir(brainsDir(), { withFileTypes: true });
  const manifests: BrainManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // A directory that is not a channel id was not written by us, and passing
    // it to `brainDir` would throw rather than skip it.
    const manifest = await readJsonFile(
      join(brainsDir(), entry.name, 'manifest.json'),
      brainManifestSchema
    );
    if (manifest !== undefined) manifests.push(manifest);
  }

  return manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteBrain(channelId: string): Promise<boolean> {
  const directory = brainDir(channelId);
  const existed = existsSync(directory);

  await rm(directory, { recursive: true, force: true });
  forgetBrainCorpus(channelId);

  return existed;
}

// -- Profile -------------------------------------------------------------

export async function readProfile(channelId: string): Promise<string | undefined> {
  const path = profilePath(channelId);
  if (!existsSync(path)) return undefined;
  return readFile(path, 'utf-8');
}

export async function writeProfile(channelId: string, content: string): Promise<string> {
  await ensureBrainDir(channelId);
  const path = profilePath(channelId);
  await writeFile(path, content, 'utf-8');
  return path;
}

export function hasProfile(channelId: string): boolean {
  return existsSync(profilePath(channelId));
}

// -- Build lock ----------------------------------------------------------

/**
 * Run `build` with exclusive access to a brain.
 *
 * Two builds of one channel would interleave their manifest checkpoints, and
 * the later write would silently drop whatever the other had recorded since it
 * last read. A lock file rather than an in-process mutex because a second
 * server process — a second editor window, a stray `npm start` — is the case
 * that actually happens.
 *
 * The lock is released on any exit from `build`, including cancellation. A
 * process killed outright leaves one behind, which is why it is also broken
 * when its owner is gone or when it is simply too old to be real.
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
