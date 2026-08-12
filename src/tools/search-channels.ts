import { z } from 'zod';
import { searchChannels } from '../utils/youtube.js';
import { formatCount, pageInfo, toolResult } from '../utils/format.js';
import { channelInfoSchema, paginationShape } from '../schemas.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const searchChannelsSchema = {
  query: z
    .string()
    .describe('Search query for YouTube channels (e.g., "web development", "machine learning")'),
  limit: z
    .number()
    .min(1)
    .max(20)
    .default(5)
    .describe('Maximum number of channels to return (1-20, default: 5)'),
};

export const searchChannelsOutputSchema = {
  query: z.string(),
  channels: z.array(channelInfoSchema),
  ...paginationShape,
};

export async function searchChannelsHandler({
  query,
  limit,
}: {
  query: string;
  limit: number;
}): Promise<CallToolResult> {
  const channels = await searchChannels(query, limit);
  const structured = { query, channels, ...pageInfo(channels.length, channels.length) };

  if (channels.length === 0) {
    return toolResult(`No channels found for "${query}".`, structured);
  }

  const lines: string[] = [
    `Found ${channels.length} channel${channels.length !== 1 ? 's' : ''} for "${query}"`,
    '',
  ];

  channels.forEach((ch, i) => {
    const subs = ch.subscriberCount > 0 ? ` · ${formatCount(ch.subscriberCount)} subscribers` : '';
    lines.push(`${i + 1}. ${ch.name}${ch.handle ? ` (${ch.handle})` : ''}`);
    lines.push(`   ${ch.channelUrl}${subs}`);
    if (ch.description) {
      lines.push(`   ${ch.description.slice(0, 120)}${ch.description.length > 120 ? '...' : ''}`);
    }
    lines.push('');
  });

  return toolResult(lines.join('\n'), structured);
}
