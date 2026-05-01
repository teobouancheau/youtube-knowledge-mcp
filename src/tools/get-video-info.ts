import { z } from 'zod';
import { getVideoInfo } from '../utils/youtube.js';
import { formatCount, textContent } from '../utils/format.js';

export const getVideoInfoSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
};

export async function getVideoInfoHandler({ video }: { video: string }) {
  const info = await getVideoInfo(video);

  const stats = [
    info.viewCount > 0 ? `${formatCount(info.viewCount)} views` : null,
    info.likeCount > 0 ? `${formatCount(info.likeCount)} likes` : null,
    info.commentCount > 0 ? `${formatCount(info.commentCount)} comments` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const lines: string[] = [
    info.title,
    `by ${info.channel}`,
    '',
    `${info.durationFormatted} · ${info.uploadDate || 'Unknown date'}`,
    ...(stats ? [stats] : []),
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

  return textContent(lines.join('\n'));
}
