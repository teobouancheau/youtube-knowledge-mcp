import { existsSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { brainManifestSchema, type BrainManifest } from '../brain-schemas.js';
import { YouTubeError } from './errors.js';
import { readJsonFile, writeFileAtomic, writeJsonAtomic } from './json-file.js';
import { ensurePrivateDir } from './paths.js';
import { brainDir, brainsDir, manifestPath, profilePath } from './brain-paths.js';
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

export async function ensureBrainDir(channelId: string): Promise<string> {
  const directory = brainDir(channelId);
  return ensurePrivateDir(directory);
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
  await writeFileAtomic(path, content);
  return path;
}

export function hasProfile(channelId: string): boolean {
  return existsSync(profilePath(channelId));
}
