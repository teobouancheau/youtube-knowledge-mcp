import { z } from 'zod';
import { channelInfoSchema, recordOfValid } from './schemas.js';

/**
 * The shapes a channel's saved thumbnails are made of.
 *
 * As with the brains: a shape is declared once and used by both the manifest
 * on disk and the tools that report it, so the two cannot drift apart. Every
 * size recorded here was decoded from the saved bytes, never read off a URL.
 */

export const thumbnailTabSchema = z
  .enum(['videos', 'shorts', 'streams'])
  .describe('Which tab of the channel a video was listed under');

export type ThumbnailTab = z.infer<typeof thumbnailTabSchema>;

export const thumbnailQualitySchema = z
  .enum(['best', 'listed'])
  .describe(
    'best tries the largest image YouTube serves and falls back to the listed one; listed fetches only the listed image'
  );

export type ThumbnailQuality = z.infer<typeof thumbnailQualitySchema>;

export const imageFormatSchema = z.enum(['jpg', 'png', 'webp']);

export const thumbnailStateSchema = z
  .enum(['pending', 'saved', 'failed'])
  .describe('pending and failed entries are retried by the next fetch_channel_thumbnails call');

/** What is recorded about a saved image; absent until the state is `saved`. */
const savedImageShape = {
  file: z
    .string()
    .optional()
    .describe(
      'Relative to the channel thumbnail directory; informational, never used to locate a file'
    ),
  sourceUrl: z.string().optional(),
  variant: z
    .string()
    .optional()
    .describe('maxresdefault, sddefault, hqdefault, listed or uncropped'),
  width: z.number().int().optional().describe('Decoded from the saved bytes'),
  height: z.number().int().optional().describe('Decoded from the saved bytes'),
  bytes: z.number().int().optional(),
  format: imageFormatSchema.optional(),
  fetchedAt: z.string().optional().describe('ISO 8601'),
  error: z.string().optional().describe('Failure code, when state is failed'),
};

export const thumbnailEntrySchema = z.object({
  videoId: z.string(),
  title: z.string(),
  url: z.string(),
  tab: thumbnailTabSchema,
  isShort: z.boolean().describe('Listed under /shorts, or the listed thumbnail is portrait'),
  durationSeconds: z.number(),
  liveStatus: z.string().optional(),
  listedUrl: z.string().optional().describe('Largest thumbnail the channel listing carried'),
  listedWidth: z.number().int().optional(),
  listedHeight: z.number().int().optional(),
  state: thumbnailStateSchema,
  ...savedImageShape,
});

export type ThumbnailEntry = z.infer<typeof thumbnailEntrySchema>;

export const channelImageSchema = z.object({
  kind: z.enum(['avatar', 'banner']),
  state: thumbnailStateSchema,
  ...savedImageShape,
});

export type ChannelImage = z.infer<typeof channelImageSchema>;

export const thumbnailTabStatsSchema = z.object({
  tab: thumbnailTabSchema,
  videoCount: z.number().int(),
  savedCount: z.number().int(),
});

export const thumbnailStatsSchema = z.object({
  videoCount: z.number().int(),
  savedCount: z.number().int(),
  failedCount: z.number().int(),
  pendingCount: z.number().int(),
  totalBytes: z.number().int().describe('Bytes of every saved video thumbnail'),
  tabs: z.array(thumbnailTabStatsSchema),
});

export type ThumbnailStats = z.infer<typeof thumbnailStatsSchema>;

/** The on-disk document. */
export const thumbnailManifestSchema = z.object({
  version: z.number().int(),
  channel: channelInfoSchema,
  tabs: z.array(thumbnailTabSchema).describe('Every tab fetched so far'),
  quality: thumbnailQualitySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  avatar: channelImageSchema.optional(),
  banner: channelImageSchema.optional(),
  videos: recordOfValid(thumbnailEntrySchema),
  stats: thumbnailStatsSchema,
});

export type ThumbnailManifest = z.infer<typeof thumbnailManifestSchema>;

/** One row of a listing of thumbnail sets. */
export const thumbnailSummarySchema = z.object({
  channelId: z.string(),
  name: z.string(),
  handle: z.string(),
  channelUrl: z.string(),
  updatedAt: z.string(),
  videoCount: z.number().int(),
  savedCount: z.number().int(),
  hasAvatar: z.boolean(),
  hasBanner: z.boolean(),
});
