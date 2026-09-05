import type { ThumbnailManifest, ThumbnailQuality, ThumbnailTab } from '../thumbnail-schemas.js';
import { inBatches } from './batches.js';
import { reportProgress, throwIfAborted } from './context.js';
import { channelImage, fetchOne, reconciled, type TabListing } from './thumbnail-entry.js';

export type { TabListing } from './thumbnail-entry.js';
import {
  THUMBNAIL_MANIFEST_VERSION,
  computeThumbnailStats,
  writeThumbnailManifest,
} from './thumbnail-store.js';
import { concurrencyState } from './ytdlp.js';
import type { ChannelInfo } from './youtube.js';

/**
 * Fetching a channel's thumbnails, resumably.
 *
 * Shaped like a brain build, and for the same reason: several hundred images
 * is several hundred requests, so the job gets interrupted — cancelled by the
 * client, throttled by YouTube, or killed with the editor. Per-image state
 * rather than one flag, checkpoints rather than one write at the end, a
 * failed image costing only itself, and a second call that continues.
 */

export const CHECKPOINT_EVERY_ITEMS = 20;
export const RATE_LIMIT_TOLERANCE = 3;

export interface FetchThumbnailsOptions {
  channel: ChannelInfo;
  listings: TabListing[];
  existing: ThumbnailManifest | undefined;
  quality: ThumbnailQuality;
}

export interface FetchThumbnailsResult {
  manifest: ThumbnailManifest;
  considered: number;
  fetched: number;
  skipped: number;
  failed: number;
  failures: { videoId: string; tab: ThumbnailTab; error: string }[];
  stoppedEarly: boolean;
  stopReason?: string;
}

export async function fetchChannelThumbnails(
  options: FetchThumbnailsOptions
): Promise<FetchThumbnailsResult> {
  const { channel, listings, existing, quality } = options;
  const { channelId } = channel;
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const tabs = [...new Set([...(existing?.tabs ?? []), ...listings.map((l) => l.tab)])];

  const entries = await reconciled(channelId, existing, listings);
  const images = { avatar: existing?.avatar, banner: existing?.banner };

  const save = async (): Promise<ThumbnailManifest> => {
    const manifest: ThumbnailManifest = {
      version: THUMBNAIL_MANIFEST_VERSION,
      channel,
      tabs,
      quality,
      createdAt,
      updatedAt: new Date().toISOString(),
      ...(images.avatar === undefined ? {} : { avatar: images.avatar }),
      ...(images.banner === undefined ? {} : { banner: images.banner }),
      videos: Object.fromEntries(entries),
      stats: computeThumbnailStats([...entries.values()]),
    };
    await writeThumbnailManifest(manifest);
    return manifest;
  };

  images.avatar = await channelImage(channelId, 'avatar', channel.avatarUrl, images.avatar);
  images.banner = await channelImage(channelId, 'banner', channel.bannerUrl, images.banner);

  const outstanding = [...entries.values()].filter((e) => e.state !== 'saved');
  const failures: FetchThumbnailsResult['failures'] = [];
  let attempted = 0;
  let fetched = 0;
  let consecutiveThrottles = 0;
  let stopReason: string | undefined;

  try {
    await inBatches(outstanding, concurrencyState().limit, async (entry) => {
      if (stopReason !== undefined) return;
      throwIfAborted();

      const updated = await fetchOne(channelId, entry, quality);
      entries.set(entry.videoId, updated);

      attempted++;
      if (updated.state === 'saved') fetched++;
      else
        failures.push({
          videoId: entry.videoId,
          tab: entry.tab,
          error: updated.error ?? 'FETCH_FAILED',
        });

      consecutiveThrottles = updated.error === 'RATE_LIMITED' ? consecutiveThrottles + 1 : 0;
      if (consecutiveThrottles >= RATE_LIMIT_TOLERANCE)
        stopReason = 'YouTube is rate limiting image downloads.';

      reportProgress(
        attempted,
        outstanding.length,
        `Fetched ${attempted} of ${outstanding.length}`
      );
      if (attempted % CHECKPOINT_EVERY_ITEMS === 0) await save();
    });
  } catch (error) {
    // A cancelled job keeps what it fetched since the last checkpoint.
    await save();
    throw error;
  }

  const manifest = await save();
  return {
    manifest,
    considered: entries.size,
    fetched,
    skipped: entries.size - outstanding.length,
    failed: failures.length,
    failures,
    stoppedEarly: stopReason !== undefined,
    ...(stopReason === undefined ? {} : { stopReason }),
  };
}
