import { join, relative } from 'node:path';
import type { ImageFormat } from './image-dimensions.js';
import { dataDir } from './paths.js';
import { assertChannelId, assertVideoId } from './validate.js';
import type { ThumbnailTab } from '../thumbnail-schemas.js';

/**
 * Every file a channel's thumbnails are made of.
 *
 * A sibling of the brains rather than inside them: deleting a brain removes
 * its whole directory, and a channel's images should outlive its corpus. Keyed
 * on the channel id, validated once here; a filename is the video id, also
 * validated here; and the tab and format are closed enums. Nothing a caller or
 * a hand-edited manifest supplies reaches a path unchecked.
 */

export function thumbnailsDir(): string {
  return dataDir('thumbnails');
}

export function thumbnailDir(channelId: string): string {
  return join(thumbnailsDir(), assertChannelId(channelId));
}

export function thumbnailManifestPath(channelId: string): string {
  return join(thumbnailDir(channelId), 'manifest.json');
}

export function thumbnailLockPath(channelId: string): string {
  return join(thumbnailDir(channelId), 'fetch.lock');
}

export function channelImagePath(
  channelId: string,
  kind: 'avatar' | 'banner',
  format: ImageFormat
): string {
  return join(thumbnailDir(channelId), 'channel', `${kind}.${format}`);
}

export function videoThumbnailPath(
  channelId: string,
  tab: ThumbnailTab,
  videoId: string,
  format: ImageFormat
): string {
  return join(thumbnailDir(channelId), tab, `${assertVideoId(videoId)}.${format}`);
}

/** The informational `file` field: where a file sits inside the channel directory. */
export function relativeFile(channelId: string, absolute: string): string {
  return relative(thumbnailDir(channelId), absolute);
}
