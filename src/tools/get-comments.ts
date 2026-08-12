import { z } from 'zod';
import { getComments } from '../utils/youtube.js';
import { textContent } from '../utils/format.js';
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

export async function getCommentsHandler({
  video,
  limit,
}: {
  video: string;
  limit: number;
}): Promise<CallToolResult> {
  const comments = await getComments(video, limit);

  if (comments.length === 0) {
    return textContent('No comments found for this video.');
  }

  const lines: string[] = [`${comments.length} top comments`, ''];

  comments.forEach((c, i) => {
    const pinned = c.isPinned ? ' [pinned]' : '';
    const likes = c.likeCount > 0 ? ` (${c.likeCount.toLocaleString()} likes)` : '';
    lines.push(`${i + 1}. @${c.author}${pinned}${likes}`);
    lines.push(`   ${c.text}`);
    lines.push('');
  });

  return textContent(lines.join('\n'));
}
