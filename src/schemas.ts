import { z } from 'zod';

/**
 * Domain schemas.
 *
 * Every tool declares an output schema, so a client receives typed
 * `structuredContent` alongside the readable text rather than having to parse
 * prose. The shapes live here because several tools return the same ones, and
 * because the documents this server writes to disk are read back through the
 * same definitions — a persisted shape and the shape a tool reports are the
 * same shape, and declaring them twice is how they drift.
 */

/**
 * A record whose unreadable values are dropped rather than failing the parse.
 *
 * These describe files this process wrote but does not own: they survive
 * upgrades, get synced between machines, and are plain JSON anyone can edit. A
 * single corrupt entry should cost that one entry, not the whole document.
 */
export function recordOfValid<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): z.ZodType<Record<string, T>, z.ZodTypeDef, Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).transform((entries) => {
    const valid: Record<string, T> = {};
    for (const [key, value] of Object.entries(entries)) {
      const parsed = schema.safeParse(value);
      if (parsed.success) valid[key] = parsed.data;
    }
    return valid;
  });
}

export const paginationShape = {
  total: z.number().int().describe('Total items available'),
  count: z.number().int().describe('Items in this response'),
  offset: z.number().int().describe('Offset of the first item returned'),
  hasMore: z.boolean().describe('Whether more items exist beyond this page'),
  nextOffset: z.number().int().optional().describe('Offset to pass to retrieve the next page'),
};

export const videoSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  durationSeconds: z.number(),
  durationFormatted: z.string(),
  url: z.string(),
  channel: z.string().optional(),
  viewCount: z.number().optional(),
  uploadDate: z.string().optional(),
});

export const videoInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  channel: z.string(),
  durationSeconds: z.number(),
  durationFormatted: z.string(),
  uploadDate: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  url: z.string(),
  thumbnailUrl: z.string(),
  viewCount: z.number(),
  likeCount: z.number(),
  commentCount: z.number(),
});

export const chapterSchema = z.object({
  title: z.string(),
  startSeconds: z.number(),
  startFormatted: z.string(),
  endSeconds: z.number(),
  endFormatted: z.string(),
  url: z.string().describe('Link that opens the video at this chapter'),
});

export const commentSchema = z.object({
  author: z.string(),
  text: z.string(),
  likeCount: z.number(),
  isPinned: z.boolean(),
});

export const channelInfoSchema = z.object({
  name: z.string(),
  channelId: z.string(),
  handle: z.string(),
  subscriberCount: z.number(),
  channelUrl: z.string(),
  description: z.string(),
});

export const playlistInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  channel: z.string(),
  handle: z.string(),
  channelUrl: z.string(),
  videoCount: z.number(),
  lastModified: z.string(),
  url: z.string(),
  description: z.string(),
});

export const videoFormatSchema = z.object({
  formatId: z.string(),
  ext: z.string(),
  resolution: z.string(),
  fps: z.number().optional(),
  vcodec: z.string(),
  acodec: z.string(),
  filesizeBytes: z.number().optional(),
  note: z.string(),
  kind: z.enum(['video+audio', 'video-only', 'audio-only']),
});

export const transcriptSegmentSchema = z.object({
  startSeconds: z.number(),
  endSeconds: z.number(),
  text: z.string(),
});

export const transcriptMatchSchema = z.object({
  startSeconds: z.number(),
  startFormatted: z.string(),
  text: z.string(),
  url: z.string().describe('Link that opens the video at this moment'),
});

export const libraryMetadataSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  channel: z.string(),
  url: z.string(),
  tags: z.array(z.string()),
  dateSaved: z.string(),
  hasTranscript: z.boolean(),
  hasSummary: z.boolean(),
  hasSkill: z.boolean(),
});

export const librarySearchHitSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  kind: z.string(),
  score: z.number(),
  excerpt: z.string(),
});

export const clipResultSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  filePath: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  durationSeconds: z.number(),
});

export const binaryStatusSchema = z.object({
  name: z.string(),
  installed: z.boolean(),
  version: z.string().optional(),
  warning: z.string().optional(),
});
