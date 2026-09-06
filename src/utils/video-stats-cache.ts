import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { dataDir, ensurePrivateDir } from './paths.js';
import { readJsonFile, writeJsonAtomic } from './json-file.js';
import { envInt } from './env.js';
import { assertVideoId } from './validate.js';
import { extractVideoId } from './youtube-url.js';
import {
  fetchVideoStatsRow,
  toVideoStats,
  videoStatsRowSchema,
  type VideoStats,
} from './video-stats.js';

/**
 * Keeping one video's stats on disk.
 *
 * Every per-video read goes through here, so get_video_info, get_chapters, a
 * caption inventory and a catalogue detail pass share a single request rather
 * than making one each. Requests are what gets a client throttled, so this is
 * the largest reduction available.
 *
 * The cached document is the yt-dlp row, not the derived object: the row is
 * what has a schema, and re-deriving on read means a cached video and a fresh
 * one always come back through the same code path. Shaped after
 * transcript-cache.ts — sharded so no directory grows to 100,000 entries,
 * validated on read, and anything unreadable treated as absent.
 */

/**
 * Resolved per call, not once at import.
 *
 * A module-level dataDir() reads the home directory the instant the module
 * loads, which is before a test can point HOME anywhere — and it means the
 * path is fixed for the process. store-paths.ts uses functions for the same
 * reason.
 */
function cacheDir(): string {
  return dataDir('stats');
}

/** Counts move constantly, so a day is already generous. */
const VIDEO_STATS_TTL_MS = envInt('YOUTUBE_MCP_STATS_TTL_MS', 86_400_000, { min: 0 });

/** Bumped when the stored shape changes, so old files are refetched, not misread. */
const CACHE_VERSION = 1;

const cachedStatsSchema = z.object({
  version: z.literal(CACHE_VERSION),
  fetchedAt: z.number(),
  row: videoStatsRowSchema,
});

function shardDir(videoId: string): string {
  return join(cacheDir(), assertVideoId(videoId).slice(0, 2));
}

function cachePath(videoId: string): string {
  return join(shardDir(videoId), `${assertVideoId(videoId)}.json`);
}

function isFresh(fetchedAt: number, now: number): boolean {
  return VIDEO_STATS_TTL_MS === 0 || now - fetchedAt < VIDEO_STATS_TTL_MS;
}

export interface StatsResult {
  stats: VideoStats;
  /** True when served from disk rather than refetched. */
  cached: boolean;
}

/**
 * A video's stats, from disk when a fresh copy is there.
 *
 * A cache write that fails is not allowed to fail the read: the caller already
 * has the answer, and a full disk should cost speed, not correctness.
 */
export async function readVideoStats(
  urlOrId: string,
  options: { refresh?: boolean } = {},
  now = Date.now()
): Promise<StatsResult> {
  // The id comes from the URL, not from a fetch: checking the cache after
  // fetching would be no cache at all.
  const videoId = extractVideoId(urlOrId);

  if (options.refresh !== true) {
    const path = cachePath(videoId);
    if (existsSync(path)) {
      const parsed = await readJsonFile(path, cachedStatsSchema);
      if (parsed !== undefined && isFresh(parsed.fetchedAt, now)) {
        return { stats: toVideoStats(parsed.row), cached: true };
      }
    }
  }

  const row = await fetchVideoStatsRow(urlOrId);

  await ensurePrivateDir(shardDir(videoId));
  await writeJsonAtomic(cachePath(videoId), {
    version: CACHE_VERSION,
    fetchedAt: now,
    row,
  }).catch(() => undefined);

  return { stats: toVideoStats(row), cached: false };
}
