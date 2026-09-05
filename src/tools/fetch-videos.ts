import { z } from 'zod';
import { listVideos } from '../utils/youtube.js';
import { pageInfo, toolResult } from '../utils/format.js';
import { paginationShape, videoSummarySchema } from '../schemas.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const fetchVideosSchema = {
  url: z
    .string()
    .max(2048)
    .describe(
      'YouTube playlist URL, channel URL, or channel handle (e.g., https://www.youtube.com/@channel)'
    ),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of videos to return (1-100, default: 20)'),
};

export const fetchVideosOutputSchema = {
  source: z.string(),
  videos: z.array(videoSummarySchema),
  ...paginationShape,
};

export async function fetchVideosHandler({
  url,
  limit,
}: {
  url: string;
  limit: number;
}): Promise<CallToolResult> {
  const videos = await listVideos(url, limit);

  const lines: string[] = [`✓ Found ${videos.length} video${videos.length !== 1 ? 's' : ''}`, ''];

  videos.forEach((v, i) => {
    lines.push(`${i + 1}. ${v.title}`);
    lines.push(`   ${v.durationFormatted} · ${v.uploadDate || 'Unknown date'}`);
    lines.push(`   ${v.url}`);
    lines.push('');
  });

  return toolResult(lines.join('\n'), {
    source: url,
    videos: videos.map((v) => ({
      id: v.id,
      title: v.title,
      durationSeconds: v.duration,
      durationFormatted: v.durationFormatted,
      url: v.url,
      uploadDate: v.uploadDate,
      ...(v.thumbnailUrl === undefined ? {} : { thumbnailUrl: v.thumbnailUrl }),
      ...(v.viewCount === undefined ? {} : { viewCount: v.viewCount }),
    })),
    ...pageInfo(videos.length, videos.length),
  });
}
