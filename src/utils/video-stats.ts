import { z } from 'zod';
import { TIMEOUTS, parseYtDlpJson, runYtDlp } from './ytdlp.js';
import { extractVideoId, formatDuration, watchUrl } from './youtube-url.js';
import { classifyPlayability } from './errors.js';
import { videoStatsRowSchema, type MusicCredits, type VideoFormat } from './video-stats-schema.js';

export { videoStatsRowSchema } from './video-stats-schema.js';
export {
  CATALOG_DESCRIPTION_PREVIEW_CHARS,
  MAX_DETAIL_JSON_BYTES,
  STRIPPED_KEYS,
  stripForStorage,
} from './video-stats-storage.js';
export type { MusicCredits, VideoFormat } from './video-stats-schema.js';

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
  channelUrl?: string;
  uploader?: string;
  license?: string;
  language?: string;
  /** yt-dlp's own label, such as `video`, `short` or `livestream`. */
  mediaType?: string;
  playableInEmbed?: boolean;
  /** Unix seconds a premiere or scheduled video goes live. */
  releaseTimestamp?: number;
  music?: MusicCredits;
  video?: VideoFormat;
}

/** `{ [key]: value }` when yt-dlp told us something, `{}` when it said null or nothing. */
function present<K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> {
  const field: Partial<Record<K, V>> = {};
  if (value !== null && value !== undefined) field[key] = value;
  return field;
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

  const music: MusicCredits = {
    ...present('track', row.track),
    ...present('artist', row.artist),
    ...present('album', row.album),
    ...present('releaseYear', row.release_year),
  };
  const format: VideoFormat = {
    ...present('width', row.width),
    ...present('height', row.height),
    ...present('fps', row.fps),
  };

  return {
    id: row.id,
    title: row.title ?? 'Unknown',
    url: watchUrl(row.id),
    channel: row.channel ?? 'Unknown',
    ...present('channelId', row.channel_id),
    ...present('channelFollowerCount', row.channel_follower_count),
    ...present('channelUrl', row.channel_url),
    ...present('uploader', row.uploader),
    uploadDate: row.upload_date ?? '',
    durationSeconds: duration,
    durationFormatted: formatDuration(Math.floor(duration)),
    ...present('viewCount', row.view_count),
    ...present('likeCount', row.like_count),
    ...present('commentCount', row.comment_count),
    categories: row.categories ?? [],
    tags: row.tags ?? [],
    ageLimit: row.age_limit ?? 0,
    ...present('availability', row.availability),
    ...present('liveStatus', row.live_status),
    ...present('license', row.license),
    ...present('language', row.language),
    ...present('mediaType', row.media_type),
    ...present('playableInEmbed', row.playable_in_embed),
    ...present('releaseTimestamp', row.release_timestamp),
    ...(Object.keys(music).length === 0 ? {} : { music }),
    ...(Object.keys(format).length === 0 ? {} : { video: format }),
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
    ...present('thumbnailUrl', row.thumbnail),
  };
}

/** One `-j` read, serving info, details, chapters, captions and the heatmap. */
export async function fetchVideoStatsRow(
  urlOrId: string,
  options: {
    /**
     * Have yt-dlp return a video YouTube refuses to serve as a row, with `availability`
     * filled in, instead of failing. Without it a private video fails with a message that
     * asks to sign in, which reads as a session problem rather than as that one video.
     */
    tolerateRefusal?: boolean;
  } = {}
): Promise<z.infer<typeof videoStatsRowSchema>> {
  const videoId = extractVideoId(urlOrId);
  const args = ['-j', '--skip-download'];
  if (options.tolerateRefusal === true) args.push('--ignore-no-formats-error');

  const stdout = await runYtDlp(args, {
    label: 'get_video_stats',
    timeoutMs: TIMEOUTS.metadata,
    target: watchUrl(videoId),
  });

  return parseYtDlpJson(stdout, videoStatsRowSchema, 'video stats');
}

export async function getVideoStats(urlOrId: string): Promise<VideoStats> {
  return toVideoStats(await fetchVideoStatsRow(urlOrId));
}
