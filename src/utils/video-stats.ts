import { z } from 'zod';
import { TIMEOUTS, parseYtDlpJson, runYtDlp } from './ytdlp.js';
import { extractVideoId, formatDuration, watchUrl } from './youtube-url.js';
import { classifyPlayability } from './errors.js';

/**
 * One full read of a video, serving every caller that needs part of it.
 *
 * `getVideoInfo` ran a narrow `--print` and `getVideoDetails` ran a full `-j`
 * and discarded all but three fields, so a single video cost two spawns for
 * data one already had. Requests to YouTube are the thing that gets a client
 * throttled, so halving them is the cheapest reliability win available.
 *
 * What is NOT kept matters as much as what is. Measured on a 637KB payload:
 * `automatic_captions` is 460,965 bytes (72%) of URLs that expire, `formats`
 * another 113,601 (18%), and `heatmap` 6,589 — larger than the whole rest of
 * the record. Stripped, a video is 4,785 bytes. Storing the raw object would
 * cost 6.4GB per 10,000 videos instead of 48MB.
 */

/** A stored snapshot must stay small enough that a catalogue is not mostly URLs. */
export const MAX_DETAIL_JSON_BYTES = 32_768;

/** Keys dropped before storage: expiring URLs and bulk we can re-fetch. */
export const STRIPPED_KEYS = [
  'formats',
  'requested_formats',
  'automatic_captions',
  'subtitles',
  'thumbnails',
  'comments',
  'heatmap',
] as const;

const heatmapEntrySchema = z.object({
  start_time: z.number(),
  end_time: z.number(),
  value: z.number(),
});

export const videoStatsRowSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  channel: z.string().nullish(),
  channel_id: z.string().nullish(),
  channel_url: z.string().nullish(),
  channel_follower_count: z.number().nullish(),
  upload_date: z.string().nullish(),
  duration: z.number().nullish(),
  view_count: z.number().nullish(),
  like_count: z.number().nullish(),
  comment_count: z.number().nullish(),
  concurrent_view_count: z.number().nullish(),
  categories: z.array(z.string()).nullish(),
  tags: z.array(z.string()).nullish(),
  age_limit: z.number().nullish(),
  availability: z.string().nullish(),
  live_status: z.string().nullish(),
  was_live: z.boolean().nullish(),
  is_live: z.boolean().nullish(),
  description: z.string().nullish(),
  thumbnail: z.string().nullish(),
  chapters: z
    .array(z.object({ title: z.string(), start_time: z.number(), end_time: z.number() }))
    .nullish(),
  heatmap: z.array(heatmapEntrySchema).nullish(),
  automatic_captions: z.record(z.string(), z.unknown()).nullish(),
  subtitles: z.record(z.string(), z.unknown()).nullish(),
});

export interface VideoStats {
  id: string;
  title: string;
  url: string;
  channel: string;
  channelId?: string;
  channelFollowerCount?: number;
  uploadDate: string;
  durationSeconds: number;
  durationFormatted: string;
  viewCount?: number;
  likeCount?: number;
  /** YouTube's own count. Trustworthy here because this read has no --write-comments. */
  commentCount?: number;
  categories: string[];
  tags: string[];
  ageLimit: number;
  availability?: string;
  liveStatus?: string;
  wasLive: boolean;
  chapters: { title: string; startTime: number; endTime: number }[];
  /** Language tags only — never the URL arrays, which are 72% of the payload. */
  captions: { manual: string[]; automatic: string[] };
  hasHeatmap: boolean;
  heatmap?: { startSeconds: number; endSeconds: number; value: number }[];
  descriptionChars: number;
  description: string;
  thumbnailUrl?: string;
}

export const CATALOG_DESCRIPTION_PREVIEW_CHARS = 500;

/** Drops the bulk keys, so what is stored is the record rather than its attachments. */
export function stripForStorage(raw: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (STRIPPED_KEYS.some((stripped) => stripped === key)) continue;
    kept[key] = value;
  }

  const description = kept.description;
  if (typeof description === 'string' && description.length > CATALOG_DESCRIPTION_PREVIEW_CHARS) {
    kept.description = description.slice(0, CATALOG_DESCRIPTION_PREVIEW_CHARS);
    kept.description_truncated = true;
  }

  return kept;
}

export function toVideoStats(row: z.infer<typeof videoStatsRowSchema>): VideoStats {
  // classifyPlayability RETURNS the error rather than throwing it, so ignoring
  // the result would hand back ordinary-looking stats for a private or
  // members-only video.
  const unplayable = classifyPlayability({
    availability: row.availability ?? undefined,
    liveStatus: row.live_status ?? undefined,
  });
  if (unplayable !== undefined) throw unplayable;

  const duration = row.duration ?? 0;
  const heatmap = row.heatmap ?? undefined;
  const description = row.description ?? '';

  return {
    id: row.id,
    title: row.title ?? 'Unknown',
    url: watchUrl(row.id),
    channel: row.channel ?? 'Unknown',
    ...(row.channel_id === null || row.channel_id === undefined
      ? {}
      : { channelId: row.channel_id }),
    ...(row.channel_follower_count === null || row.channel_follower_count === undefined
      ? {}
      : { channelFollowerCount: row.channel_follower_count }),
    uploadDate: row.upload_date ?? '',
    durationSeconds: duration,
    durationFormatted: formatDuration(Math.floor(duration)),
    ...(row.view_count === null || row.view_count === undefined
      ? {}
      : { viewCount: row.view_count }),
    ...(row.like_count === null || row.like_count === undefined
      ? {}
      : { likeCount: row.like_count }),
    ...(row.comment_count === null || row.comment_count === undefined
      ? {}
      : { commentCount: row.comment_count }),
    categories: row.categories ?? [],
    tags: row.tags ?? [],
    ageLimit: row.age_limit ?? 0,
    ...(row.availability === null || row.availability === undefined
      ? {}
      : { availability: row.availability }),
    ...(row.live_status === null || row.live_status === undefined
      ? {}
      : { liveStatus: row.live_status }),
    wasLive: row.was_live ?? false,
    chapters: (row.chapters ?? []).map((chapter) => ({
      title: chapter.title,
      startTime: chapter.start_time,
      endTime: chapter.end_time,
    })),
    // Keys only: the values are arrays of expiring URLs, and the inventory is
    // what a caller actually asks about.
    captions: {
      manual: Object.keys(row.subtitles ?? {}),
      automatic: Object.keys(row.automatic_captions ?? {}),
    },
    hasHeatmap: heatmap !== undefined && heatmap.length > 0,
    ...(heatmap === undefined
      ? {}
      : {
          heatmap: heatmap.map((entry) => ({
            startSeconds: entry.start_time,
            endSeconds: entry.end_time,
            value: entry.value,
          })),
        }),
    descriptionChars: description.length,
    description,
    ...(row.thumbnail === null || row.thumbnail === undefined
      ? {}
      : { thumbnailUrl: row.thumbnail }),
  };
}

/** One `-j` read, serving info, details, chapters, captions and the heatmap. */
export async function fetchVideoStatsRow(
  urlOrId: string
): Promise<z.infer<typeof videoStatsRowSchema>> {
  const videoId = extractVideoId(urlOrId);
  const stdout = await runYtDlp(['-j', '--skip-download'], {
    label: 'get_video_stats',
    timeoutMs: TIMEOUTS.metadata,
    target: watchUrl(videoId),
  });

  return parseYtDlpJson(stdout, videoStatsRowSchema, 'video stats');
}

export async function getVideoStats(urlOrId: string): Promise<VideoStats> {
  return toVideoStats(await fetchVideoStatsRow(urlOrId));
}
