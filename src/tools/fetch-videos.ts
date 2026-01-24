import { z } from 'zod';
import { listVideos } from '../utils/youtube.js';

export const fetchVideosSchema = {
  url: z.string().describe('YouTube playlist or channel URL'),
  limit: z.number().min(1).max(100).default(20).describe('Maximum number of videos to fetch'),
};

export async function fetchVideosHandler({ url, limit }: { url: string; limit: number }) {
  const videos = await listVideos(url, limit);

  const output = {
    count: videos.length,
    videos: videos.map((v) => ({
      id: v.id,
      title: v.title,
      duration: v.durationFormatted,
      date: v.uploadDate,
      url: v.url,
    })),
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
