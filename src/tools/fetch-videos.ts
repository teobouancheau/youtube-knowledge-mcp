import { z } from 'zod';
import { listVideos } from '../utils/youtube.js';

export const fetchVideosSchema = {
  url: z.string().describe('YouTube playlist or channel URL'),
  limit: z.number().min(1).max(100).default(20).describe('Maximum number of videos to fetch'),
};

export async function fetchVideosHandler({ url, limit }: { url: string; limit: number }) {
  const videos = await listVideos(url, limit);

  const lines: string[] = [`✓ Found ${videos.length} video${videos.length !== 1 ? 's' : ''}`, ''];

  videos.forEach((v, i) => {
    lines.push(`${i + 1}. ${v.title}`);
    lines.push(`   ${v.durationFormatted} · ${v.uploadDate || 'Unknown date'}`);
    lines.push(`   ${v.url}`);
    lines.push('');
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: lines.join('\n'),
      },
    ],
  };
}
