import { z } from 'zod';
import { searchVideos } from '../utils/youtube.js';
import { formatCount, textContent } from '../utils/format.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const searchVideosSchema = {
  query: z
    .string()
    .describe('Search query (e.g., "machine learning tutorial", "react hooks explained")'),
  limit: z
    .number()
    .min(1)
    .max(20)
    .default(5)
    .describe('Maximum number of results to return (1-20, default: 5)'),
};

export async function searchVideosHandler({
  query,
  limit,
}: {
  query: string;
  limit: number;
}): Promise<CallToolResult> {
  const results = await searchVideos(query, limit);

  const lines: string[] = [
    `Found ${results.length} result${results.length !== 1 ? 's' : ''} for "${query}"`,
    '',
  ];

  results.forEach((v, i) => {
    const views = v.viewCount > 0 ? ` · ${formatCount(v.viewCount)} views` : '';
    lines.push(`${i + 1}. ${v.title}`);
    lines.push(`   ${v.durationFormatted} · ${v.channel}${views}`);
    lines.push(`   ${v.url}`);
    lines.push('');
  });

  return textContent(lines.join('\n'));
}
