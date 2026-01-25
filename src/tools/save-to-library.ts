import { z } from 'zod';
import { saveToLibrary } from '../utils/storage.js';

export const saveToLibrarySchema = {
  video_id: z.string().describe('YouTube video ID'),
  title: z.string().describe('Video title'),
  content: z.string().describe('Content to save (summary, notes, or skill)'),
  content_type: z
    .enum(['summary', 'skill'])
    .default('summary')
    .describe('Type of content being saved'),
  channel: z.string().optional().describe('Channel name'),
  tags: z.array(z.string()).optional().describe('Tags for categorization'),
};

export async function saveToLibraryHandler({
  video_id,
  title,
  content,
  content_type,
  channel,
  tags,
}: {
  video_id: string;
  title: string;
  content: string;
  content_type: 'summary' | 'skill';
  channel?: string;
  tags?: string[];
}) {
  const result = await saveToLibrary({
    videoId: video_id,
    title,
    content,
    contentType: content_type,
    channel,
    tags,
  });

  const lines: string[] = [`✓ Saved ${content_type} to library`, '', title];

  if (channel) {
    lines.push(`by ${channel}`);
  }

  if (tags && tags.length > 0) {
    lines.push(`tags: ${tags.join(', ')}`);
  }

  lines.push('');
  lines.push(result.path);

  return {
    content: [
      {
        type: 'text' as const,
        text: lines.join('\n'),
      },
    ],
  };
}
