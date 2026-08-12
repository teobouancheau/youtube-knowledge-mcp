import { z } from 'zod';
import { getChannelInfo } from '../utils/youtube.js';
import { formatCount, textContent } from '../utils/format.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const getChannelInfoSchema = {
  channel: z.string().describe('YouTube channel URL, handle (e.g., @Fireship), or channel name'),
};

export async function getChannelInfoHandler({
  channel,
}: {
  channel: string;
}): Promise<CallToolResult> {
  const info = await getChannelInfo(channel);

  const lines: string[] = [
    info.name,
    info.handle ? info.handle : '',
    `${formatCount(info.subscriberCount)} subscribers`,
    info.channelUrl,
  ].filter(Boolean);

  if (info.description) {
    lines.push('');
    lines.push(info.description);
  }

  return textContent(lines.join('\n'));
}
