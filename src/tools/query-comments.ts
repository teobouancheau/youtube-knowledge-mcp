import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { pageInfo, toolResult } from '../utils/format.js';
import { paginationShape } from '../schemas.js';
import { coverageSchema } from '../harvest-schemas.js';
import { getStore } from '../utils/store.js';
import { countComments, queryComments } from '../utils/comment-store.js';
import { readReceipt } from '../utils/harvest-receipts.js';
import type { Coverage } from '../harvest-schemas.js';

export const queryCommentsSchema = {
  video: z.string().max(2048).optional().describe('Restrict to one video id'),
  channel: z.string().max(64).optional().describe('Restrict to one channel id'),
  match: z
    .string()
    .max(512)
    .optional()
    .describe(
      'Full-text query over comment text, SQLite FTS5 syntax: bare words, "quoted phrases", ' +
        'AND / OR / NOT, prefix*. Omit to browse by order instead.'
    ),
  author: z.string().max(256).optional().describe('Match on author id, or exact author name'),
  minLikes: z.number().int().min(0).default(0),
  topLevelOnly: z.boolean().default(false),
  threadOf: z
    .string()
    .max(64)
    .optional()
    .describe('A comment id: returns that comment and its replies, in reply order'),
  order: z.enum(['likes', 'newest', 'oldest', 'relevance']).default('likes'),
  limit: z.number().int().min(1).max(200).default(25),
  offset: z.number().int().min(0).default(0),
};

export const queryCommentsOutputSchema = {
  comments: z.array(
    z.object({
      id: z.string(),
      videoId: z.string(),
      parentId: z.string().nullable(),
      author: z.string(),
      authorId: z.string().optional(),
      text: z.string(),
      likeCount: z.number().int(),
      isPinned: z.boolean(),
      authorIsUploader: z.boolean(),
      publishedAt: z.string().optional(),
    })
  ),
  coverage: z
    .array(coverageSchema)
    .describe(
      'Coverage of the videos these results were drawn from. `total` counts rows IN THIS STORE — ' +
        'it is not the number of comments those videos have, and these receipts are what says so.'
    ),
  ...paginationShape,
};

/**
 * Searches comments already in the store.
 *
 * The one place in this server where `total` is honestly a total: the dataset
 * is local and fixed, so it is a real COUNT(*) and the offset genuinely works.
 * It is paired with coverage so "total: 4,312" cannot be read as "the video
 * has 4,312 comments".
 */
export async function queryCommentsHandler(input: {
  video?: string;
  channel?: string;
  match?: string;
  author?: string;
  minLikes: number;
  topLevelOnly: boolean;
  threadOf?: string;
  order: 'likes' | 'newest' | 'oldest' | 'relevance';
  limit: number;
  offset: number;
}): Promise<CallToolResult> {
  const store = await getStore();
  const query = {
    ...(input.video === undefined ? {} : { videoId: input.video }),
    ...(input.channel === undefined ? {} : { channelId: input.channel }),
    ...(input.match === undefined ? {} : { match: input.match }),
    ...(input.author === undefined ? {} : { authorId: input.author }),
    ...(input.threadOf === undefined ? {} : { threadOf: input.threadOf }),
    minLikes: input.minLikes,
    topLevelOnly: input.topLevelOnly,
    order: input.order,
    limit: input.limit,
    offset: input.offset,
  };

  const rows = queryComments(store, query);
  const total = countComments(store, query);

  const videoIds = [...new Set(rows.map((row) => row.video_id))];
  const coverage = videoIds
    .map((videoId) => readReceipt(store, 'video-comments', videoId))
    .filter((receipt): receipt is Coverage => receipt !== undefined);

  const incomplete = coverage.filter((receipt) => !receipt.complete).length;
  const lines = [
    `${String(rows.length)} of ${String(total)} matching comments in the store.`,
    ...(incomplete > 0
      ? [
          `${String(incomplete)} of the ${String(coverage.length)} videos these came from are only partly harvested — this is a sample of their comments, not all of them.`,
        ]
      : []),
    '',
    ...rows.map(
      (row) =>
        `${row.author}${row.author_is_uploader ? ' (uploader)' : ''}: ${row.text.replace(/\s+/g, ' ').slice(0, 200)} — ${String(row.like_count)} likes`
    ),
  ];

  return toolResult(lines.join('\n'), {
    comments: rows.map((row) => ({
      id: row.comment_id,
      videoId: row.video_id,
      parentId: row.parent_id,
      author: row.author,
      ...(row.author_id === null ? {} : { authorId: row.author_id }),
      text: row.text,
      likeCount: row.like_count,
      isPinned: row.is_pinned,
      authorIsUploader: row.author_is_uploader,
      ...(row.published_at === null
        ? {}
        : { publishedAt: new Date(row.published_at * 1000).toISOString() }),
    })),
    coverage,
    ...pageInfo({ total, count: rows.length, offset: input.offset }),
  });
}
