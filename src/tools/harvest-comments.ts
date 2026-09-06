import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toolResult } from '../utils/format.js';
import { getStore, inTransaction } from '../utils/store.js';
import { getComments, getVideoDetails } from '../utils/youtube-video.js';
import { saveThreads, countComments } from '../utils/comment-store.js';
import { saveReceipt } from '../utils/harvest-receipts.js';
import { coverageOf } from '../utils/coverage.js';
import { renderCoverage } from '../utils/coverage-text.js';
import { coverageSchema } from '../harvest-schemas.js';
import { withVideoHarvestLock } from '../utils/harvest-lock.js';
import { extractVideoId } from '../utils/youtube-url.js';

export const MAX_COMMENTS_PER_VIDEO = 100_000;

export const harvestCommentsSchema = {
  video: z.string().max(2048).describe('YouTube video ID or URL'),
  maxComments: z
    .number()
    .int()
    .min(1)
    .max(MAX_COMMENTS_PER_VIDEO)
    .default(5_000)
    .describe(
      `Comments to extract, replies included (max ${String(MAX_COMMENTS_PER_VIDEO)}). At a measured ` +
        '~17 comments/second this is roughly 5 minutes per 5,000.'
    ),
  sort: z
    .enum(['top', 'new'])
    .default('new')
    .describe(
      'Defaults to "new": under a cap, "top" returns a biased prefix rather than a sample, ' +
        'which is the wrong shape for an exhaustive harvest.'
    ),
  maxRepliesPerThread: z.number().int().min(0).max(1_000).default(100),
};

export const harvestCommentsOutputSchema = {
  videoId: z.string(),
  added: z.number().int().describe('Comments in the store for this video after the run'),
  written: z.number().int().describe('Rows written, including ones that already existed'),
  topLevel: z.number().int(),
  replies: z.number().int(),
  orphanReplies: z
    .number()
    .int()
    .describe('Replies whose parent a cap cut away, so their threads are incomplete'),
  coverage: coverageSchema,
};

/**
 * Extracts a video's comments into the store.
 *
 * There is no comment cursor — yt-dlp emits one object at the end of the walk,
 * so an interrupted run keeps nothing for that video. The resume story is
 * therefore "run it again with a larger cap", and the receipt says so rather
 * than implying a continuation that does not exist.
 */
export async function harvestCommentsHandler({
  video,
  maxComments,
  sort,
  maxRepliesPerThread,
}: {
  video: string;
  maxComments: number;
  sort: 'top' | 'new';
  maxRepliesPerThread: number;
}): Promise<CallToolResult> {
  const videoId = extractVideoId(video);
  const store = await getStore();

  return withVideoHarvestLock(videoId, async () => {
    const startedAt = Date.now();
    const [result, details] = await Promise.all([
      getComments(video, { limit: maxComments, sort, maxRepliesPerThread }),
      getVideoDetails(video).catch(() => undefined),
    ]);

    const reported = details?.commentCount;
    const capBound = result.extractedTotal >= maxComments;

    const coverage = coverageOf({
      scope: 'video-comments',
      targetId: videoId,
      have: result.extractedTotal,
      source: `yt-dlp --write-comments comment_sort=${sort}`,
      ranToExhaustion: result.ranToExhaustion,
      ...(result.commentsDisabled
        ? {
            expected: { value: 0, source: 'youtube:comment_count' as const },
            reason: 'COMMENTS_DISABLED' as const,
          }
        : reported === undefined
          ? {}
          : { expected: { value: reported, source: 'youtube:comment_count' as const } }),
      ...(capBound ? { limitApplied: maxComments } : {}),
      sortApplied: sort,
      ...(capBound
        ? {
            note: 'There is no comment cursor: re-run with a larger maxComments to extract more.',
          }
        : {}),
    });

    // Rows and the receipt describing them commit together, so the receipt can
    // never claim comments the store does not hold.
    const written = inTransaction(store, () => {
      // The video row must exist for the foreign key; a harvest may run before
      // the channel has been catalogued.
      store.prepare('INSERT OR IGNORE INTO video (video_id) VALUES (?)').run(videoId);
      const count = saveThreads(store, videoId, result.threads);
      saveReceipt(store, coverage, { startedAt });
      return count;
    });

    const stored = countComments(store, { videoId });
    const lines = [
      renderCoverage(coverage),
      '',
      `${String(stored)} comments in the store for ${videoId} (${String(result.rootCount)} top level, ${String(result.replyCount)} replies).`,
      ...(result.orphanCount > 0
        ? [
            `${String(result.orphanCount)} replies have no parent here, so those threads are partial.`,
          ]
        : []),
    ];

    return toolResult(lines.join('\n'), {
      videoId,
      added: stored,
      written,
      topLevel: result.rootCount,
      replies: result.replyCount,
      orphanReplies: result.orphanCount,
      coverage,
    });
  });
}
