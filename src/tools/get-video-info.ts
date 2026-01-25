import { z } from 'zod';
import { getVideoInfo } from '../utils/youtube.js';

export const getVideoInfoSchema = {
  video: z.string().describe('YouTube video ID or URL'),
};

export async function getVideoInfoHandler({ video }: { video: string }) {
  const info = await getVideoInfo(video);

  const lines: string[] = [
    info.title,
    `by ${info.channel}`,
    '',
    `${info.durationFormatted} · ${info.uploadDate || 'Unknown date'}`,
    info.url,
  ];

  if (info.tags.length > 0) {
    lines.push('');
    lines.push(`tags: ${info.tags.join(', ')}`);
  }

  if (info.description) {
    lines.push('');
    lines.push(info.description);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: lines.join('\n'),
      },
    ],
  };
}
