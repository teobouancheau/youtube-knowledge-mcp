import { z } from 'zod';

/**
 * The shapes yt-dlp's JSON output is checked against.
 *
 * Every field is optional or nullable: yt-dlp emits `null` for what it could
 * not find and omits what it never looked for, and a row missing a field is
 * still a usable row. What the schemas guarantee is that a field that *is*
 * present has the type the code reads it as — which the previous "is it an
 * object" guard did not.
 */

/** `--print '%(.{...})j'` for one video: yt-dlp writes `null` for what it did not find. */
export const videoInfoRowSchema = z.object({
  id: z.string().nullish(),
  title: z.string().nullish(),
  channel: z.string().nullish(),
  duration: z.number().nullish(),
  upload_date: z.string().nullish(),
  description: z.string().nullish(),
  // Kept loose on purpose: a tag list is read for the strings it holds, and a
  // video whose tags field is odd should still be readable.
  tags: z.unknown(),
  thumbnail: z.string().nullish(),
  view_count: z.number().nullish(),
  like_count: z.number().nullish(),
  comment_count: z.number().nullish(),
  availability: z.string().nullish(),
  live_status: z.string().nullish(),
});

/** `--print 'after_move:%(.{title,filepath})j'`: where yt-dlp put the finished file. */
export const afterMoveRowSchema = z.object({
  title: z.string().nullish(),
  filepath: z.string().nullish(),
});

export const chapterRowSchema = z.object({
  title: z.string(),
  start_time: z.number(),
  end_time: z.number(),
});

export const videoDetailsRowSchema = z.object({
  chapters: z.array(chapterRowSchema).nullish(),
  upload_date: z.string().nullish(),
  duration: z.number().nullish(),
  /**
   * The video's real comment count — trustworthy ONLY here, because this read
   * does not pass --write-comments. With that flag yt-dlp replaces the value
   * with the number it extracted (measured: 300 against a video with 2.4M).
   */
  comment_count: z.number().nullish(),
});

/**
 * Every field yt-dlp returns for a comment, verified against 2026.08.19.
 *
 * Nine of these were previously dropped on the floor after being paid for:
 * the extraction fetches them either way, so discarding `id` and `parent`
 * meant a thread could not be rebuilt from what we already had.
 */
export const commentRowSchema = z.object({
  id: z.string().nullish(),
  author: z.string().nullish(),
  author_id: z.string().nullish(),
  author_url: z.string().nullish(),
  author_thumbnail: z.string().nullish(),
  author_is_uploader: z.boolean().nullish(),
  author_is_verified: z.boolean().nullish(),
  text: z.string().nullish(),
  like_count: z.number().nullish(),
  is_pinned: z.boolean().nullish(),
  is_favorited: z.boolean().nullish(),
  timestamp: z.number().nullish(),
  _time_text: z.string().nullish(),
  /** 'root' for a top-level comment; the parent's id for a reply. */
  parent: z.string().nullish(),
});

export const commentsRowSchema = z.object({
  comments: z.array(commentRowSchema).nullish(),
  /**
   * With --write-comments yt-dlp OVERWRITES this with the number extracted,
   * and sets it to null when the extraction was interrupted. So it is a
   * three-state signal about this run, never the video's real total, which
   * only a separate metadata pass can report.
   */
  comment_count: z.number().nullish(),
});

export const formatRowSchema = z.object({
  format_id: z.string(),
  ext: z.string(),
  resolution: z.string().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  fps: z.number().nullish(),
  vcodec: z.string().nullish(),
  acodec: z.string().nullish(),
  filesize: z.number().nullish(),
  filesize_approx: z.number().nullish(),
  format_note: z.string().nullish(),
});

export const formatsRowSchema = z.object({
  formats: z.array(formatRowSchema).nullish(),
});

export const captionTracksSchema = z.object({
  subtitles: z.record(z.string(), z.unknown()).nullish(),
  automatic_captions: z.record(z.string(), z.unknown()).nullish(),
});

/**
 * yt-dlp's search rows. Only `id` is required — the rest are absent often
 * enough (age-gated entries, deleted uploads still in the index) that treating
 * them as guaranteed is what produced `undefined` in rendered output.
 */
export const searchResultSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  duration: z.number().nullish(),
  channel: z.string().nullish(),
  view_count: z.number().nullish(),
  url: z.string().nullish(),
});

export const channelSearchRowSchema = z.object({
  id: z.string().nullish(),
  title: z.string().nullish(),
  channel: z.string().nullish(),
  channel_id: z.string().nullish(),
  channel_url: z.string().nullish(),
  uploader_id: z.string().nullish(),
  channel_follower_count: z.number().nullish(),
  description: z.string().nullish(),
});

export const channelMetaSchema = z.object({
  channel: z.string().nullish(),
  channel_id: z.string().nullish(),
  channel_url: z.string().nullish(),
  uploader_id: z.string().nullish(),
  channel_follower_count: z.number().nullish(),
  description: z.string().nullish(),
  /** Checked by `selectChannelImages`, which tolerates any shape. */
  thumbnails: z.unknown(),
});

export const playlistMetaSchema = z.object({
  id: z.string().nullish(),
  title: z.string().nullish(),
  channel: z.string().nullish(),
  channel_url: z.string().nullish(),
  uploader_id: z.string().nullish(),
  playlist_count: z.number().nullish(),
  modified_date: z.string().nullish(),
  webpage_url: z.string().nullish(),
  description: z.string().nullish(),
});
