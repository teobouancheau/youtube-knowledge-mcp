import { z } from 'zod';
import { getComments, getVideoDetails } from '../utils/youtube-video.js';
import { toolResult } from '../utils/format.js';
import { commentSchema, commentThreadSchema } from '../schemas.js';
import { coverageSchema } from '../harvest-schemas.js';
import { coverageOf } from '../utils/coverage.js';
import { renderCoverage } from '../utils/coverage-text.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const getCommentsSchema = {
  video: z.string().max(2048).describe('YouTube video ID or URL'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(20)
    .describe('Comments to extract, replies included (1-500, default 20)'),
  includeReplies: z
    .boolean()
    .default(false)
    .describe(
      'Return full threads instead of top-level comments only. Replies are fetched either ' +
        'way — this decides whether they are reported or thrown away.'
    ),
  sort: z
    .enum(['top', 'new'])
    .default('top')
    .describe('"top" under a cap is a biased prefix; "new" is what an exhaustive read should use'),
};

export const getCommentsOutputSchema = {
  comments: z.array(commentSchema).describe('Top-level comments, unchanged in shape'),
  threads: z
    .array(commentThreadSchema)
    .optional()
    .describe('Full threads with replies. Present when includeReplies is true.'),
  extractedTotal: z.number().int().describe('Comments held from this read: roots plus replies'),
  orphanReplies: z
    .number()
    .int()
    .describe('Replies whose parent was cut by the cap, so their threads are incomplete'),
  coverage: coverageSchema,
};

/**
 * A sample of a video's comments, with a receipt saying so.
 *
 * There is no cursor: YouTube exposes none for a live comment read, so this
 * cannot page. `coverage.expected` is the video's real comment count, read
 * from a separate metadata pass — yt-dlp overwrites `comment_count` with the
 * number it extracted whenever --write-comments is used, so the number cannot
 * come from the same call that fetched the comments.
 */
export async function getCommentsHandler({
  video,
  limit,
  includeReplies,
  sort,
}: {
  video: string;
  limit: number;
  includeReplies: boolean;
  sort: 'top' | 'new';
}): Promise<CallToolResult> {
  const [result, details] = await Promise.all([
    getComments(video, { limit, sort }),
    getVideoDetails(video).catch(() => undefined),
  ]);

  const reported = details?.commentCount;
  const capBound = result.extractedTotal >= limit;

  const coverage = coverageOf({
    scope: 'video-comments',
    targetId: video,
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
    ...(capBound ? { limitApplied: limit } : {}),
    sortApplied: sort,
    ...(capBound
      ? { note: `Call again with a larger limit, or harvest_channel, to extract more.` }
      : {}),
  });

  const roots = result.threads.filter((thread) => thread.comment.parentId === null);
  const lines = [renderCoverage(coverage), ''];

  roots.forEach((thread, index) => {
    const { comment } = thread;
    lines.push(`${String(index + 1)}. ${comment.author}${comment.isPinned ? ' (pinned)' : ''}`);
    lines.push(`   ${comment.text}`);
    lines.push(
      `   ${String(comment.likeCount)} likes${thread.replyCount > 0 ? ` · ${String(thread.replyCount)} replies` : ''}`
    );
    lines.push('');
  });

  return toolResult(lines.join('\n'), {
    comments: roots.map((thread) => ({
      author: thread.comment.author,
      text: thread.comment.text,
      likeCount: thread.comment.likeCount,
      isPinned: thread.comment.isPinned,
    })),
    ...(includeReplies ? { threads: result.threads } : {}),
    extractedTotal: result.extractedTotal,
    orphanReplies: result.orphanCount,
    coverage,
  });
}
