import { z } from 'zod';
import { toolResult } from '../utils/format.js';
import { chapterSchema } from '../schemas.js';
import { deepLink } from '../utils/transcript.js';
import { extractVideoId, getChapters } from '../utils/youtube.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const getChaptersSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
};

export const getChaptersOutputSchema = {
  videoId: z.string(),
  chapters: z.array(chapterSchema),
  count: z.number().int(),
};

export async function getChaptersHandler({ video }: { video: string }): Promise<CallToolResult> {
  const chapters = await getChapters(video);
  const videoId = extractVideoId(video);

  const structured = {
    videoId,
    chapters: chapters.map((ch) => ({
      title: ch.title,
      startSeconds: ch.startTime,
      startFormatted: ch.startTimeFormatted,
      endSeconds: ch.endTime,
      endFormatted: ch.endTimeFormatted,
      url: deepLink(videoId, ch.startTime),
    })),
    count: chapters.length,
  };

  if (chapters.length === 0) {
    return toolResult('No chapters found for this video.', structured);
  }

  const lines: string[] = [`${chapters.length} chapters`, ''];

  chapters.forEach((ch, i) => {
    lines.push(`${i + 1}. [${ch.startTimeFormatted} - ${ch.endTimeFormatted}] ${ch.title}`);
  });

  return toolResult(lines.join('\n'), structured);
}
