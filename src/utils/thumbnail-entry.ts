import { rm } from 'node:fs/promises';
import {
  imageFormatSchema,
  type ChannelImage,
  type ThumbnailEntry,
  type ThumbnailManifest,
  type ThumbnailQuality,
  type ThumbnailTab,
} from '../thumbnail-schemas.js';
import { throwIfAborted } from './context.js';
import { asYouTubeError } from './errors.js';
import { largestThumbnail } from './flat-listing.js';
import { MAX_IMAGE_BYTES } from './image-fetch.js';
import { writeFileAtomic } from './json-file.js';
import { climb, videoRungs, type Climbed } from './thumbnail-ladder.js';
import { channelImagePath, relativeFile, videoThumbnailPath } from './thumbnail-paths.js';
import { channelImageFile, entryPath, isIntact } from './thumbnail-store.js';
import type { VideoListItem } from './youtube.js';

/** One thumbnail at a time: what is recorded about it, and how it is fetched and saved. */

export interface TabListing {
  tab: ThumbnailTab;
  videos: VideoListItem[];
}

const ALL_FORMATS = imageFormatSchema.options;

/**
 * Per-video entries, reconciled against the files actually on disk.
 *
 * A record that says `saved` whose file is missing or the wrong size goes back
 * to `pending`; a video in today's listing that has no record gets one; and a
 * record for a video not listed today is kept, since its file is still a
 * thumbnail and the tab may simply not have been requested this time.
 */
export async function reconciled(
  channelId: string,
  existing: ThumbnailManifest | undefined,
  listings: TabListing[]
): Promise<Map<string, ThumbnailEntry>> {
  const entries = new Map<string, ThumbnailEntry>();

  for (const [videoId, recorded] of Object.entries(existing?.videos ?? {})) {
    const intact = await isIntact(entryPath(channelId, recorded), recorded.bytes);
    entries.set(videoId, intact ? recorded : { ...recorded, state: 'pending' });
  }

  for (const { tab, videos } of listings) {
    for (const video of videos) {
      if (!entries.has(video.id)) entries.set(video.id, pendingEntry(tab, video));
    }
  }

  return entries;
}

function pendingEntry(tab: ThumbnailTab, video: VideoListItem): ThumbnailEntry {
  const listed = largestThumbnail(video.thumbnails ?? []);
  const portrait =
    listed?.width !== null &&
    listed?.width !== undefined &&
    listed.height !== null &&
    listed.height !== undefined &&
    listed.height > listed.width;

  return {
    videoId: video.id,
    title: video.title,
    url: video.url,
    tab,
    isShort: tab === 'shorts' || portrait,
    durationSeconds: video.duration,
    ...(video.liveStatus === undefined ? {} : { liveStatus: video.liveStatus }),
    ...(listed === undefined ? {} : { listedUrl: listed.url }),
    ...(listed?.width === null || listed?.width === undefined ? {} : { listedWidth: listed.width }),
    ...(listed?.height === null || listed?.height === undefined
      ? {}
      : { listedHeight: listed.height }),
    state: 'pending',
  };
}

export async function fetchOne(
  channelId: string,
  entry: ThumbnailEntry,
  quality: ThumbnailQuality
): Promise<ThumbnailEntry> {
  const listed =
    entry.listedUrl === undefined
      ? undefined
      : {
          url: entry.listedUrl,
          ...(entry.listedWidth === undefined ? {} : { width: entry.listedWidth }),
          ...(entry.listedHeight === undefined ? {} : { height: entry.listedHeight }),
        };

  try {
    const climbed = await climb(
      videoRungs(entry.videoId, listed, entry.isShort, quality),
      MAX_IMAGE_BYTES
    );
    const path = videoThumbnailPath(channelId, entry.tab, entry.videoId, climbed.probe.format);
    await replaceFile(path, climbed, (format) =>
      videoThumbnailPath(channelId, entry.tab, entry.videoId, format)
    );
    return { ...withoutSaved(entry), state: 'saved', ...saved(channelId, path, climbed) };
  } catch (error) {
    throwIfAborted();
    return { ...withoutSaved(entry), state: 'failed', error: asYouTubeError(error).code };
  }
}

export async function channelImage(
  channelId: string,
  kind: 'avatar' | 'banner',
  url: string | undefined,
  recorded: ChannelImage | undefined
): Promise<ChannelImage | undefined> {
  if (url === undefined) return recorded;
  if (
    recorded !== undefined &&
    (await isIntact(channelImageFile(channelId, recorded), recorded.bytes))
  ) {
    return recorded;
  }

  try {
    const climbed = await climb([{ variant: 'uncropped', url }], MAX_IMAGE_BYTES);
    const path = channelImagePath(channelId, kind, climbed.probe.format);
    await replaceFile(path, climbed, (format) => channelImagePath(channelId, kind, format));
    return { kind, state: 'saved', ...saved(channelId, path, climbed) };
  } catch (error) {
    throwIfAborted();
    return { kind, state: 'failed', error: asYouTubeError(error).code };
  }
}

/** Write the image, and remove an earlier file of the same name in another format. */
async function replaceFile(
  path: string,
  climbed: Climbed,
  pathFor: (format: (typeof ALL_FORMATS)[number]) => string
): Promise<void> {
  await writeFileAtomic(path, climbed.bytes);
  for (const format of ALL_FORMATS) {
    if (format !== climbed.probe.format) await rm(pathFor(format), { force: true });
  }
}

function saved(channelId: string, path: string, climbed: Climbed): Partial<ThumbnailEntry> {
  return {
    file: relativeFile(channelId, path),
    sourceUrl: climbed.rung.url,
    variant: climbed.rung.variant,
    width: climbed.probe.width,
    height: climbed.probe.height,
    bytes: climbed.bytes.byteLength,
    format: climbed.probe.format,
    fetchedAt: new Date().toISOString(),
  };
}

/** The entry with every field of a previous save removed, so a failure cannot keep stale sizes. */
function withoutSaved(entry: ThumbnailEntry): ThumbnailEntry {
  const {
    file: _file,
    sourceUrl: _sourceUrl,
    variant: _variant,
    width: _width,
    height: _height,
    bytes: _bytes,
    format: _format,
    fetchedAt: _fetchedAt,
    error: _error,
    ...rest
  } = entry;
  return rest;
}
