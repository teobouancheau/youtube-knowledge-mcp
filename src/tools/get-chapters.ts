import { z } from 'zod';
import { getChapters } from '../utils/youtube.js';
import { textContent } from '../utils/format.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const getChaptersSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
};

export async function getChaptersHandler({ video }: { video: string }): Promise<CallToolResult> {
  const chapters = await getChapters(video);

  if (chapters.length === 0) {
    return textContent('No chapters found for this video.');
  }

  const lines: string[] = [`${chapters.length} chapters`, ''];

  chapters.forEach((ch, i) => {
    lines.push(`${i + 1}. [${ch.startTimeFormatted} - ${ch.endTimeFormatted}] ${ch.title}`);
  });

  return textContent(lines.join('\n'));
}
