import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { paginationShape } from '../schemas.js';
import {
  channelImageSchema,
  thumbnailEntrySchema,
  thumbnailQualitySchema,
  thumbnailStateSchema,
  thumbnailStatsSchema,
  thumbnailTabSchema,
  type ChannelImage,
  type ThumbnailEntry,
  type ThumbnailTab,
} from '../thumbnail-schemas.js';
import { pageInfo, toolResult } from '../utils/format.js';
import { thumbnailDir } from '../utils/thumbnail-paths.js';
import {
  channelImageFile,
  deleteThumbnails,
  entryPath,
  resolveThumbnails,
} from '../utils/thumbnail-store.js';

/** Reading back, and throwing away, a channel's saved thumbnails. Neither touches the network. */

const withPath = <T extends object>(item: T, path: string | undefined): T & { path?: string } =>
  path === undefined ? item : { ...item, path };

// -- list_channel_thumbnails ---------------------------------------------

export const listChannelThumbnailsSchema = {
  channel: z.string().describe('Channel URL, @handle, name, or channel id of a fetched channel'),
  tab: thumbnailTabSchema.optional().describe('Only entries from this tab'),
  state: thumbnailStateSchema.optional().describe('Only entries in this state'),
  limit: z.number().int().min(1).max(200).default(50).describe('Maximum entries. Default: 50'),
  offset: z.number().int().min(0).default(0).describe('Skip this many entries'),
};

export const listChannelThumbnailsOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  handle: z.string(),
  directory: z.string(),
  tabs: z.array(thumbnailTabSchema),
  quality: thumbnailQualitySchema,
  updatedAt: z.string(),
  avatar: channelImageSchema.extend({ path: z.string().optional() }).optional(),
  banner: channelImageSchema.extend({ path: z.string().optional() }).optional(),
  stats: thumbnailStatsSchema,
  thumbnails: z.array(thumbnailEntrySchema.extend({ path: z.string().optional() })),
  ...paginationShape,
};

export async function listChannelThumbnailsHandler({
  channel,
  tab,
  state,
  limit,
  offset,
}: {
  channel: string;
  tab?: ThumbnailTab;
  state?: ThumbnailEntry['state'];
  limit: number;
  offset: number;
}): Promise<CallToolResult> {
  const manifest = await resolveThumbnails(channel);
  const { channelId, name, handle } = manifest.channel;

  const all = Object.values(manifest.videos).filter(
    (entry) =>
      (tab === undefined || entry.tab === tab) && (state === undefined || entry.state === state)
  );
  const page = all.slice(offset, offset + limit);
  const image = (kind: 'avatar' | 'banner'): (ChannelImage & { path?: string }) | undefined => {
    const recorded = manifest[kind];
    return recorded === undefined
      ? undefined
      : withPath(recorded, channelImageFile(channelId, recorded));
  };

  const lines = [
    `${name}: ${manifest.stats.savedCount} of ${manifest.stats.videoCount} thumbnails saved in ${thumbnailDir(channelId)}`,
    '',
    ...page.map(
      (entry) =>
        `${entry.state === 'saved' ? '✓' : '✗'} ${entry.videoId} ${entry.title}${entry.width === undefined ? '' : ` (${entry.width}x${entry.height})`}`
    ),
  ];
  if (page.length === 0) lines.push('No entries match.');

  return toolResult(lines.join('\n'), {
    channelId,
    name,
    handle,
    directory: thumbnailDir(channelId),
    tabs: manifest.tabs,
    quality: manifest.quality,
    updatedAt: manifest.updatedAt,
    ...(image('avatar') === undefined ? {} : { avatar: image('avatar') }),
    ...(image('banner') === undefined ? {} : { banner: image('banner') }),
    stats: manifest.stats,
    thumbnails: page.map((entry) => withPath(entry, entryPath(channelId, entry))),
    ...pageInfo({ total: all.length, count: page.length, offset }),
  });
}

// -- delete_channel_thumbnails -------------------------------------------

export const deleteChannelThumbnailsSchema = {
  channel: z.string().describe('Channel URL, @handle, name, or channel id of a fetched channel'),
};

export const deleteChannelThumbnailsOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  deleted: z.boolean(),
};

export async function deleteChannelThumbnailsHandler({
  channel,
}: {
  channel: string;
}): Promise<CallToolResult> {
  const manifest = await resolveThumbnails(channel);
  const { channelId, name } = manifest.channel;
  const deleted = await deleteThumbnails(channelId);

  return toolResult(
    `Deleted the thumbnails for ${name}. Call fetch_channel_thumbnails to fetch them again, at a different quality if you like.`,
    { channelId, name, deleted }
  );
}
