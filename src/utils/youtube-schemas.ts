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
});

export const commentRowSchema = z.object({
  author: z.string().nullish(),
  text: z.string().nullish(),
  like_count: z.number().nullish(),
  is_pinned: z.boolean().nullish(),
  parent: z.string().nullish(),
});

export const commentsRowSchema = z.object({
  comments: z.array(commentRowSchema).nullish(),
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
