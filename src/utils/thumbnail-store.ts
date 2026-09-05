import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  thumbnailManifestSchema,
  type ChannelImage,
  type ThumbnailEntry,
  type ThumbnailManifest,
  type ThumbnailStats,
  type ThumbnailTab,
} from '../thumbnail-schemas.js';
import { findByChannel } from './channel-lookup.js';
import { YouTubeError } from './errors.js';
import { readJsonFile, writeJsonAtomic } from './json-file.js';
import { ensurePrivateDir } from './paths.js';
import {
  channelImagePath,
  thumbnailDir,
  thumbnailManifestPath,
  thumbnailsDir,
  videoThumbnailPath,
} from './thumbnail-paths.js';

/** The manifest of a channel's thumbnails: reading, writing, finding and forgetting it. */

export const THUMBNAIL_MANIFEST_VERSION = 1;

export async function ensureThumbnailDirs(
  channelId: string,
  tabs: ThumbnailTab[]
): Promise<string> {
  const directory = await ensurePrivateDir(thumbnailDir(channelId));
  await ensurePrivateDir(join(directory, 'channel'));
  for (const tab of tabs) await ensurePrivateDir(join(directory, tab));
  return directory;
}

export async function readThumbnailManifest(
  channelId: string
): Promise<ThumbnailManifest | undefined> {
  return readJsonFile(thumbnailManifestPath(channelId), thumbnailManifestSchema);
}

export async function requireThumbnailManifest(channelId: string): Promise<ThumbnailManifest> {
  const manifest = await readThumbnailManifest(channelId);
  if (manifest === undefined) {
    throw new YouTubeError(
      'NOT_FOUND',
      `No thumbnails have been fetched for channel ${channelId}.`,
      {
        nextStep: 'Call fetch_channel_thumbnails with the channel URL or handle.',
      }
    );
  }
  return manifest;
}

export async function writeThumbnailManifest(manifest: ThumbnailManifest): Promise<void> {
  await ensurePrivateDir(thumbnailDir(manifest.channel.channelId));
  await writeJsonAtomic(thumbnailManifestPath(manifest.channel.channelId), manifest);
}

/** Every thumbnail set on disk, newest first. Unreadable directories are skipped. */
export async function listThumbnailManifests(): Promise<ThumbnailManifest[]> {
  if (!existsSync(thumbnailsDir())) return [];

  const manifests: ThumbnailManifest[] = [];
  for (const entry of await readdir(thumbnailsDir(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJsonFile(
      join(thumbnailsDir(), entry.name, 'manifest.json'),
      thumbnailManifestSchema
    );
    if (manifest !== undefined) manifests.push(manifest);
  }
  return manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The thumbnail set for a channel named any way the caller likes, from disk alone. */
export async function resolveThumbnails(channel: string): Promise<ThumbnailManifest> {
  const manifests = await listThumbnailManifests();
  const [first, second] = findByChannel(manifests, channel);

  if (first === undefined) {
    const fetched = manifests.map((m) => m.channel.handle || m.channel.name);
    throw new YouTubeError('NOT_FOUND', `No thumbnails have been fetched for "${channel}".`, {
      nextStep:
        fetched.length === 0
          ? 'Call fetch_channel_thumbnails with the channel URL or handle.'
          : `Call fetch_channel_thumbnails to fetch them. Channels with thumbnails: ${fetched.join(', ')}.`,
    });
  }
  if (second !== undefined) {
    throw new YouTubeError('INVALID_INPUT', `"${channel}" matches more than one channel.`, {
      nextStep: `Use the channel id instead: ${[first, second].map((m) => m.channel.channelId).join(', ')}.`,
    });
  }
  return first;
}

export async function deleteThumbnails(channelId: string): Promise<boolean> {
  const directory = thumbnailDir(channelId);
  const existed = existsSync(directory);
  await rm(directory, { recursive: true, force: true });
  return existed;
}

/** Where a saved entry's file is, recomputed from validated parts; never read from the manifest. */
export function entryPath(channelId: string, entry: ThumbnailEntry): string | undefined {
  if (entry.state !== 'saved' || entry.format === undefined) return undefined;
  return videoThumbnailPath(channelId, entry.tab, entry.videoId, entry.format);
}

export function channelImageFile(channelId: string, image: ChannelImage): string | undefined {
  if (image.state !== 'saved' || image.format === undefined) return undefined;
  return channelImagePath(channelId, image.kind, image.format);
}

/** True when the file a saved record describes is on disk at the recorded size. */
export async function isIntact(
  path: string | undefined,
  bytes: number | undefined
): Promise<boolean> {
  if (path === undefined) return false;
  try {
    return (await stat(path)).size === bytes;
  } catch {
    return false;
  }
}

export function computeThumbnailStats(entries: ThumbnailEntry[]): ThumbnailStats {
  const tabs = new Map<ThumbnailTab, { videoCount: number; savedCount: number }>();
  let saved = 0;
  let failed = 0;
  let pending = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    const tab = tabs.get(entry.tab) ?? { videoCount: 0, savedCount: 0 };
    tab.videoCount++;
    if (entry.state === 'saved') {
      saved++;
      tab.savedCount++;
      totalBytes += entry.bytes ?? 0;
    } else if (entry.state === 'failed') failed++;
    else pending++;
    tabs.set(entry.tab, tab);
  }

  return {
    videoCount: entries.length,
    savedCount: saved,
    failedCount: failed,
    pendingCount: pending,
    totalBytes,
    tabs: [...tabs.entries()].map(([tab, counts]) => ({ tab, ...counts })),
  };
}
