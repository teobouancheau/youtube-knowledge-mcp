import { z } from 'zod';
import { channelInfoSchema, recordOfValid } from './schemas.js';

/**
 * The shapes a channel brain is made of.
 *
 * Split from `schemas.ts` only for size; the rule there applies here too — a
 * shape is declared once and used by both the persistence layer and the tools
 * that report it, so the file on disk and the tool result cannot drift apart.
 */

/** Why a video is, or is not, part of the corpus. */
export const brainVideoStateSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  url: z.string(),
  uploadDate: z.string().describe('YYYY-MM-DD, or empty when YouTube did not report one'),
  durationSeconds: z.number(),
  state: z
    .enum(['pending', 'indexed', 'no-captions', 'failed'])
    .describe('pending and failed videos are retried by the next build_brain call'),
  chunkCount: z.number().int(),
  wordCount: z.number().int(),
  error: z.string().optional().describe('Failure code, when state is failed'),
});

export type BrainVideoState = z.infer<typeof brainVideoStateSchema>;

/** One passage of speech, addressable by timestamp. */
export const brainChunkSchema = z.object({
  id: z.string().describe('videoId:startSeconds'),
  videoId: z.string(),
  title: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  text: z.string(),
});

export type BrainChunk = z.infer<typeof brainChunkSchema>;

export const brainChunkFileSchema = z.object({
  version: z.number().int(),
  chunks: z.array(brainChunkSchema),
});

export const brainPhraseSchema = z.object({
  phrase: z.string(),
  videoCount: z.number().int().describe('Distinct videos the phrase appears in'),
  occurrences: z.number().int(),
});

export const brainMonthlyUploadsSchema = z.object({
  month: z.string().describe('YYYY-MM'),
  videos: z.number().int(),
});

/**
 * What the server can state about a channel without inferring anything.
 *
 * Everything here is counted or measured. Claims about what a creator thinks
 * belong in the profile, which a model writes from quotes it can cite.
 */
export const brainStatsSchema = z.object({
  videoCount: z.number().int(),
  indexedCount: z.number().int(),
  noCaptionsCount: z.number().int(),
  failedCount: z.number().int(),
  pendingCount: z.number().int(),
  chunkCount: z.number().int(),
  totalWords: z.number().int(),
  medianWordsPerMinute: z.number(),
  firstUpload: z.string().optional(),
  lastUpload: z.string().optional(),
  uploadsPerMonth: z.array(brainMonthlyUploadsSchema),
  recurringPhrases: z
    .array(brainPhraseSchema)
    .describe('Phrases repeated across several videos, which is what a catchphrase is'),
});

export type BrainStats = z.infer<typeof brainStatsSchema>;

/** The on-disk document. */
export const brainManifestSchema = z.object({
  version: z.number().int(),
  channel: channelInfoSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  videos: recordOfValid(brainVideoStateSchema),
  stats: brainStatsSchema,
});

export type BrainManifest = z.infer<typeof brainManifestSchema>;

/** A retrieval result: a moment in a video, with the link that opens it. */
export const brainPassageSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  startSeconds: z.number(),
  startFormatted: z.string(),
  endSeconds: z.number(),
  score: z.number(),
  text: z.string(),
  url: z.string().describe('Link that opens the video at this moment'),
});

export type BrainPassage = z.infer<typeof brainPassageSchema>;

/** One row of list_brains. */
export const brainSummarySchema = z.object({
  channelId: z.string(),
  name: z.string(),
  handle: z.string(),
  channelUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hasProfile: z.boolean(),
  videoCount: z.number().int(),
  indexedCount: z.number().int(),
  chunkCount: z.number().int(),
});

export const brainLockSchema = z.object({
  pid: z.number().int(),
  startedAt: z.string(),
});
