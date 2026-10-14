import { z } from 'zod';

/** The shape of one `yt-dlp -j` read of a video, and the small records derived from it. */

export const heatmapEntrySchema = z.object({
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
  uploader: z.string().nullish(),
  license: z.string().nullish(),
  language: z.string().nullish(),
  media_type: z.string().nullish(),
  playable_in_embed: z.boolean().nullish(),
  release_timestamp: z.number().nullish(),
  track: z.string().nullish(),
  artist: z.string().nullish(),
  album: z.string().nullish(),
  release_year: z.number().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  fps: z.number().nullish(),
});

/** What YouTube credits a track with, when a video carries music metadata. */
export interface MusicCredits {
  track?: string;
  artist?: string;
  album?: string;
  releaseYear?: number;
}

/** The frame size and rate of the best stream, as far as yt-dlp reported them. */
export interface VideoFormat {
  width?: number;
  height?: number;
  fps?: number;
}
