import { join } from 'node:path';
import { dataDir } from './paths.js';
import { assertChannelId } from './validate.js';

/**
 * Every file a brain is made of.
 *
 * Separate from the modules that read and write them so that the manifest layer
 * and the index layer can each know where things live without importing each
 * other.
 *
 * A brain is keyed on the channel id rather than the handle: handles get
 * renamed, and a renamed handle would orphan the brain built under the old one.
 * The id is also what reaches the filesystem, so it is validated here — once,
 * at the only place that turns one into a path.
 */

export function brainsDir(): string {
  return dataDir('brains');
}

export function brainDir(channelId: string): string {
  return join(brainsDir(), assertChannelId(channelId));
}

export function manifestPath(channelId: string): string {
  return join(brainDir(channelId), 'manifest.json');
}

export function chunksPath(channelId: string): string {
  return join(brainDir(channelId), 'chunks.json');
}

export function searchIndexPath(channelId: string): string {
  return join(brainDir(channelId), 'search-index.json');
}

export function profilePath(channelId: string): string {
  return join(brainDir(channelId), 'profile.md');
}

export function lockPath(channelId: string): string {
  return join(brainDir(channelId), 'build.lock');
}
