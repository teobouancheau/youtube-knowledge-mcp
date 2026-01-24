import { z } from 'zod';
import { getVideoInfo } from '../utils/youtube.js';

export const getVideoInfoSchema = {
  video: z.string().describe('YouTube video ID or URL'),
};

export async function getVideoInfoHandler({ video }: { video: string }) {
  const info = await getVideoInfo(video);

  const output = {
    id: info.id,
    title: info.title,
    channel: info.channel,
    duration: info.durationFormatted,
    date: info.uploadDate,
    description: info.description,
    tags: info.tags,
    url: info.url,
    thumbnail: info.thumbnailUrl,
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      },
    ],
  };
}
