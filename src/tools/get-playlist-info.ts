import { z } from 'zod';
import { getPlaylistInfo } from '../utils/youtube.js';
import { formatCount, textContent } from '../utils/format.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const getPlaylistInfoSchema = {
  url: z
    .string()
    .describe(
      'YouTube playlist URL (e.g., https://www.youtube.com/playlist?list=PLlrATfBNZ98dudnM48yfGUldqGD0S4FFb)'
    ),
};

export async function getPlaylistInfoHandler({ url }: { url: string }): Promise<CallToolResult> {
  const info = await getPlaylistInfo(url);

  const lines: string[] = [
    info.title,
    info.channel ? `by ${info.channel}${info.handle ? ` (${info.handle})` : ''}` : '',
    '',
    `${formatCount(info.videoCount)} videos`,
    info.lastModified ? `Last updated: ${info.lastModified}` : '',
    info.url,
  ].filter(Boolean);

  if (info.description) {
    lines.push('');
    lines.push(info.description);
  }

  return textContent(lines.join('\n'));
}
