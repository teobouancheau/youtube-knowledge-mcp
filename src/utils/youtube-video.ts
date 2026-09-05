import { formatYouTubeDate } from './format.js';
import { classifyPlayability } from './errors.js';
import { TIMEOUTS, parseYtDlpJson, runYtDlp } from './ytdlp.js';
import { commentsRowSchema, videoDetailsRowSchema } from './youtube-schemas.js';
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
      '--print',
      '%(id)s|||%(title)s|||%(channel)s|||%(duration)s|||%(upload_date)s|||%(description)s|||%(tags)j|||%(thumbnail)s|||%(view_count)s|||%(like_count)s|||%(comment_count)s|||%(availability)s|||%(live_status)s',
    ],
    { label: 'get_video_info', target: url }
  );

  // yt-dlp prints "NA" for absent fields and simply omits trailing ones, so
  // index access has to tolerate a short row rather than trust its length.
  const parts = stdout.split('|||');
  const field = (index: number): string => parts[index] ?? '';

  // Refusals reach us as a populated row rather than a failure, so this is the
  // point at which one becomes a typed error.
  const refusal = classifyPlayability({ availability: field(11), liveStatus: field(12) });
  if (refusal) throw refusal;

  const [id, title, channel, durationStr, uploadDate, description, tagsJson, thumbnailUrl] = [
    field(0),
    field(1),
    field(2),
    field(3),
    field(4),
    field(5),
    field(6),
    field(7),
  ];
  const duration = parseInt(durationStr, 10) || 0;

  let tags: string[] = [];
  try {
    const parsedTags: unknown = JSON.parse(tagsJson || '[]');
    if (Array.isArray(parsedTags)) {
      tags = parsedTags.filter((t): t is string => typeof t === 'string');
    }
  } catch {
    tags = [];
  }

  return {
    id,
    title,
    channel,
    duration,
    durationFormatted: formatDuration(duration),
    uploadDate: formatYouTubeDate(uploadDate),
    description: description || '',
    tags,
    url,
    thumbnailUrl: thumbnailUrl || '',
    viewCount: parseInt(field(8), 10) || 0,
    likeCount: parseInt(field(9), 10) || 0,
    commentCount: parseInt(field(10), 10) || 0,
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
