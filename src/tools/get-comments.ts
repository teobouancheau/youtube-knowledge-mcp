import { z } from 'zod';
import { getComments } from '../utils/youtube.js';
import { pageInfo, toolResult } from '../utils/format.js';
import { commentSchema, paginationShape } from '../schemas.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const getCommentsSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
  limit: z
    .number()
    .min(1)
    .max(50)
    .default(20)
    .describe('Maximum number of top-level comments to return (1-50, default: 20)'),
};

export const getCommentsOutputSchema = {
  comments: z.array(commentSchema),
  ...paginationShape,
};

export async function getCommentsHandler({
  video,
  limit,
}: {
  video: string;
  limit: number;
}): Promise<CallToolResult> {
  const comments = await getComments(video, limit);
  const structured = { comments, ...pageInfo({ total: comments.length, count: comments.length }) };

  if (comments.length === 0) {
    return toolResult('No comments found for this video.', structured);
  }

  const lines: string[] = [`${comments.length} top comments`, ''];

  comments.forEach((c, i) => {
    const pinned = c.isPinned ? ' [pinned]' : '';
    const likes = c.likeCount > 0 ? ` (${c.likeCount.toLocaleString()} likes)` : '';
    lines.push(`${i + 1}. @${c.author}${pinned}${likes}`);
    lines.push(`   ${c.text}`);
    lines.push('');
  });

  return toolResult(lines.join('\n'), structured);
}
