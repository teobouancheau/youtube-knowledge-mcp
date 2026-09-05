import { formatYouTubeDate } from './format.js';
import { classifyPlayability } from './errors.js';
import { TIMEOUTS, parseYtDlpJson, runYtDlp } from './ytdlp.js';
import { commentsRowSchema, videoDetailsRowSchema, videoInfoRowSchema } from './youtube-schemas.js';
import { extractVideoId, formatDuration, watchUrl } from './youtube-url.js';

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
}

export async function getVideoDetails(urlOrId: string): Promise<VideoDetails> {
  const videoId = extractVideoId(urlOrId);
  const url = watchUrl(videoId);

  const stdout = await runYtDlp(['-j', '--skip-download'], {
    label: 'get_video_details',
    target: url,
  });
  const data = parseYtDlpJson(stdout, videoDetailsRowSchema, 'video details');

  return {
    uploadDate: formatYouTubeDate(data.upload_date ?? ''),
    durationSeconds: typeof data.duration === 'number' ? data.duration : 0,
    chapters: (data.chapters ?? []).map((ch) => ({
      title: ch.title,
      startTime: ch.start_time,
      startTimeFormatted: formatDuration(Math.floor(ch.start_time)),
      endTime: ch.end_time,
      endTimeFormatted: formatDuration(Math.floor(ch.end_time)),
    })),
  };
}

export async function getComments(urlOrId: string, limit = 20): Promise<VideoComment[]> {
  const videoId = extractVideoId(urlOrId);
  const url = watchUrl(videoId);

  const stdout = await runYtDlp(
    [
      '-j',
      '--skip-download',
      '--write-comments',
      '--extractor-args',
      `youtube:comment_sort=top;max_comments=${limit}`,
    ],
    { label: 'get_comments', timeoutMs: TIMEOUTS.comments, target: url }
  );

  const data = parseYtDlpJson(stdout, commentsRowSchema, 'video comments');
  const comments = data.comments ?? [];

  return comments
    .filter((c) => c.parent === 'root')
    .slice(0, limit)
    .map((c) => ({
      author: c.author ?? 'Unknown',
      text: c.text ?? '',
      likeCount: c.like_count ?? 0,
      isPinned: c.is_pinned ?? false,
    }));
}
