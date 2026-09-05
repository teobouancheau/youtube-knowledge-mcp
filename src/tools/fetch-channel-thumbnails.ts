import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  channelImageSchema,
  thumbnailQualitySchema,
  thumbnailStatsSchema,
  thumbnailTabSchema,
  type ThumbnailQuality,
  type ThumbnailTab,
} from '../thumbnail-schemas.js';
import { YouTubeError } from '../utils/errors.js';
import { withFileLock, type LockRecord } from '../utils/file-lock.js';
import { fileResult } from '../utils/format.js';
import { fetchChannelThumbnails } from '../utils/thumbnail-fetch.js';
import { listTabs } from '../utils/thumbnail-listing.js';
import {
  thumbnailDir,
  thumbnailLockPath,
  thumbnailManifestPath,
} from '../utils/thumbnail-paths.js';
import { ensureThumbnailDirs, readThumbnailManifest } from '../utils/thumbnail-store.js';
import { assertChannelId } from '../utils/validate.js';
import { getChannelInfo } from '../utils/youtube.js';

export const fetchChannelThumbnailsSchema = {
  channel: z.string().max(256).describe('Channel URL, @handle, or name'),
  maxVideos: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe('Most recent videos to consider, per tab. Default: 100'),
  tabs: z
    .array(thumbnailTabSchema)
    .min(1)
    .default(['videos'])
    .describe(
      "Which channel tabs to read. Shorts have portrait thumbnails and are saved under shorts/. Default: ['videos']"
    ),
  quality: thumbnailQualitySchema.default('best'),
};

export const fetchChannelThumbnailsOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  handle: z.string(),
  channelUrl: z.string(),
  directory: z.string(),
  manifestPath: z.string(),
  tabs: z.array(thumbnailTabSchema),
  quality: thumbnailQualitySchema,
  considered: z.number().int().describe('Videos with a record after this call'),
  fetched: z.number().int().describe('Images saved during this call'),
  skipped: z.number().int().describe('Images already on disk'),
  failed: z.number().int(),
  failures: z.array(z.object({ videoId: z.string(), tab: thumbnailTabSchema, error: z.string() })),
  tabErrors: z
    .array(z.object({ tab: thumbnailTabSchema, error: z.string() }))
    .describe('Tabs that could not be listed'),
  avatar: channelImageSchema.optional(),
  banner: channelImageSchema.optional(),
  stoppedEarly: z.boolean(),
  stopReason: z.string().optional(),
  stats: thumbnailStatsSchema,
};

/**
 * Save every thumbnail of a channel, plus its avatar and banner.
 *
 * Idempotent by construction: images already on disk are kept, missing or
 * truncated ones are fetched again, and a second call after an interruption
 * continues. The listing is one yt-dlp call per tab; the images come from
 * YouTube's image hosts directly, so no video is extracted individually.
 */
export async function fetchChannelThumbnailsHandler({
  channel,
  maxVideos,
  tabs,
  quality,
}: {
  channel: string;
  maxVideos: number;
  tabs: ThumbnailTab[];
  quality: ThumbnailQuality;
}): Promise<CallToolResult> {
  const info = await getChannelInfo(channel);
  const channelId = assertChannelId(info.channelId);
  const wanted = [...new Set(tabs)];

  await ensureThumbnailDirs(channelId, wanted);

  const result = await withFileLock(
    thumbnailLockPath(channelId),
    async () => {
      const { listings, tabErrors } = await listTabs(info.channelUrl, wanted, maxVideos);
      const outcome = await fetchChannelThumbnails({
        channel: info,
        listings,
        existing: await readThumbnailManifest(channelId),
        quality,
      });
      return { ...outcome, tabErrors };
    },
    (existing) => alreadyFetching(channelId, existing)
  );

  const directory = thumbnailDir(channelId);
  const manifestPath = thumbnailManifestPath(channelId);
  const { manifest } = result;

  return fileResult(
    render(info.name, directory, result),
    {
      channelId,
      name: info.name,
      handle: info.handle,
      channelUrl: info.channelUrl,
      directory,
      manifestPath,
      tabs: manifest.tabs,
      quality,
      considered: result.considered,
      fetched: result.fetched,
      skipped: result.skipped,
      failed: result.failed,
      failures: result.failures,
      tabErrors: result.tabErrors,
      ...(manifest.avatar === undefined ? {} : { avatar: manifest.avatar }),
      ...(manifest.banner === undefined ? {} : { banner: manifest.banner }),
      stoppedEarly: result.stoppedEarly,
      ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
      stats: manifest.stats,
    },
    { path: manifestPath, name: `${info.name} thumbnails`, mimeType: 'application/json' }
  );
}

function alreadyFetching(channelId: string, existing: LockRecord | undefined): YouTubeError {
  const owner =
    existing === undefined ? '' : `Started at ${existing.startedAt} by process ${existing.pid}. `;
  return new YouTubeError(
    'INVALID_INPUT',
    `Thumbnails for ${channelId} are already being fetched.`,
    {
      nextStep: `${owner}Wait for it to finish, then call fetch_channel_thumbnails again to continue.`,
    }
  );
}

function render(
  name: string,
  directory: string,
  result: {
    considered: number;
    fetched: number;
    skipped: number;
    failed: number;
    tabErrors: { tab: string; error: string }[];
    stopReason?: string;
    manifest: { avatar?: { state: string }; banner?: { state: string } };
  }
): string {
  const lines = [
    `Thumbnails for ${name}: ${result.considered - result.failed} of ${result.considered} saved.`,
    '',
    `Fetched ${result.fetched} · already had ${result.skipped}${result.failed > 0 ? ` · ${result.failed} failed` : ''}`,
    `Avatar: ${result.manifest.avatar?.state ?? 'not listed'} · banner: ${result.manifest.banner?.state ?? 'not listed'}`,
    '',
    directory,
  ];
  for (const { tab, error } of result.tabErrors)
    lines.push(`The ${tab} tab could not be listed (${error}).`);
  if (result.failed > 0) lines.push('Call fetch_channel_thumbnails again to retry the failures.');
  if (result.stopReason !== undefined) {
    lines.push(
      '',
      `Stopped early: ${result.stopReason}`,
      'Call fetch_channel_thumbnails again to continue.'
    );
  }
  return lines.join('\n');
}
