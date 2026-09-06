import { formatYouTubeDate } from './format.js';
import { classifyPlayability } from './errors.js';
import { TIMEOUTS, parseYtDlpJson, runYtDlp } from './ytdlp.js';
import { commentsRowSchema, videoInfoRowSchema } from './youtube-schemas.js';
import { extractVideoId, formatDuration, watchUrl } from './youtube-url.js';
import { toThreads, type ThreadedComments } from './comment-threads.js';
import { readVideoStats } from './video-stats-cache.js';

/** Everything read about one video: metadata, chapters and comments. */

export interface VideoInfo {
  id: string;
  title: string;
  channel: string;
  duration: number;
  durationFormatted: string;
  uploadDate: string;
  description: string;
  tags: string[];
  url: string;
  thumbnailUrl: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

export interface Chapter {
  title: string;
  startTime: number;
  startTimeFormatted: string;
  endTime: number;
  endTimeFormatted: string;
}

export interface VideoComment {
  author: string;
  text: string;
  likeCount: number;
  isPinned: boolean;
}

const VIDEO_INFO_TEMPLATE =
  '%(.{id,title,channel,duration,upload_date,description,tags,thumbnail,view_count,like_count,comment_count,availability,live_status})j';

export async function getVideoInfo(urlOrId: string): Promise<VideoInfo> {
  const videoId = extractVideoId(urlOrId);
  const url = watchUrl(videoId);

  const stdout = await runYtDlp(
    [
      '--skip-download',
      // Without this, a video YouTube refuses to serve aborts extraction and the
      // only thing left to read is YouTube's localised refusal text. With it,
      // yt-dlp downgrades that abort to a warning and still fills in the
      // structured fields, so the reason can be read from `availability` and
      // `live_status` instead of guessed at from prose.
      '--ignore-no-formats-error',
      // One JSON object with exactly these fields, rather than a delimited row:
      // yt-dlp writes `null` for what it does not know, the parser checks each
      // field's type, and a description containing the delimiter cannot shift
      // every field after it.
      '--print',
      VIDEO_INFO_TEMPLATE,
    ],
    { label: 'get_video_info', target: url }
  );

  const row = parseYtDlpJson(stdout, videoInfoRowSchema, 'video metadata');

  // Refusals reach us as a populated row rather than a failure, so this is the
  // point at which one becomes a typed error.
  const refusal = classifyPlayability({
    availability: row.availability ?? undefined,
    liveStatus: row.live_status ?? undefined,
  });
  if (refusal) throw refusal;

  const duration = row.duration ?? 0;

  return {
    id: row.id ?? videoId,
    title: row.title ?? '',
    channel: row.channel ?? '',
    duration,
    durationFormatted: formatDuration(duration),
    uploadDate: formatYouTubeDate(row.upload_date ?? ''),
    description: row.description ?? '',
    tags: Array.isArray(row.tags)
      ? row.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    url,
    thumbnailUrl: row.thumbnail ?? '',
    viewCount: row.view_count ?? 0,
    likeCount: row.like_count ?? 0,
    commentCount: row.comment_count ?? 0,
  };
}

export async function getChapters(urlOrId: string): Promise<Chapter[]> {
  return (await getVideoDetails(urlOrId)).chapters;
}

/**
 * Publication date, length and chapters, from a single metadata fetch.
 *
 * Reading a channel needs all three per video, and asking for them separately
 * spawns yt-dlp twice for one identical `-j` request — doubling the requests a
 * build makes to YouTube, which is the thing most likely to get it throttled.
 * `getChapters` is the same call with everything but the chapters discarded.
 */
export interface VideoDetails {
  uploadDate: string;
  durationSeconds: number;
  chapters: Chapter[];
  /** YouTube's own count, from a read without --write-comments. Approximate and lagging. */
  commentCount?: number;
}

export async function getVideoDetails(urlOrId: string): Promise<VideoDetails> {
  // A projection of the one full read, not a second spawn. This used to run
  // its own `-j` and discard everything but three fields, so a caller wanting
  // a title and a chapter list paid for two extractions of the same video.
  const { stats } = await readVideoStats(urlOrId);

  return {
    uploadDate: stats.uploadDate,
    durationSeconds: stats.durationSeconds,
    chapters: stats.chapters.map((chapter) => ({
      title: chapter.title,
      startTime: chapter.startTime,
      startTimeFormatted: formatDuration(Math.floor(chapter.startTime)),
      endTime: chapter.endTime,
      endTimeFormatted: formatDuration(Math.floor(chapter.endTime)),
    })),
    ...(stats.commentCount === undefined ? {} : { commentCount: stats.commentCount }),
  };
}

export interface CommentsResult extends ThreadedComments {
  /**
   * Whether yt-dlp's own iteration finished rather than being cut off.
   *
   * From common.py:3882-3908: `comment_count` is overwritten with the number
   * extracted, and set to null when the walk was interrupted. Necessary for
   * completeness but NOT sufficient — `itertools.islice` also ends iteration
   * at a cap, so a capped run reports that it finished too.
   */
  ranToExhaustion: boolean;
  /** True when the video has comments turned off, where zero is the real total. */
  commentsDisabled: boolean;
  extractedTotal: number;
}

export async function getComments(
  urlOrId: string,
  options: { limit?: number; sort?: 'top' | 'new'; maxRepliesPerThread?: number } = {}
): Promise<CommentsResult> {
  const limit = options.limit ?? 20;
  const sort = options.sort ?? 'top';
  const videoId = extractVideoId(urlOrId);
  const url = watchUrl(videoId);

  const stdout = await runYtDlp(
    [
      '-j',
      '--skip-download',
      '--write-comments',
      '--extractor-args',
      // Five positions, per _video.py:2578: total, parents, replies, per
      // thread, depth. An omitted position means unbounded, not a default, so
      // every one is stated. Depth is 2 because YouTube's tree is two levels
      // and a deeper cap would spend requests on nothing.
      youtubeCommentArgs({ limit, sort, maxRepliesPerThread: options.maxRepliesPerThread ?? 100 }),
    ],
    { label: 'get_comments', timeoutMs: TIMEOUTS.comments, target: url }
  );

  const data = parseYtDlpJson(stdout, commentsRowSchema, 'video comments');
  const rows = data.comments ?? [];

  return {
    ...toThreads(rows),
    ranToExhaustion: data.comment_count !== null && data.comment_count !== undefined,
    commentsDisabled:
      (data.comments === null || data.comments === undefined) &&
      (data.comment_count === null || data.comment_count === undefined),
    extractedTotal: rows.length,
  };
}

function youtubeCommentArgs(options: {
  limit: number;
  sort: 'top' | 'new';
  maxRepliesPerThread: number;
}): string {
  const parents = Math.max(1, Math.ceil(options.limit / 2));
  const replies = Math.max(0, options.limit - parents);
  return [
    `youtube:comment_sort=${options.sort}`,
    `max_comments=${String(options.limit)},${String(parents)},${String(replies)},${String(options.maxRepliesPerThread)},2`,
  ].join(';');
}
