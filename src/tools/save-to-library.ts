import { z } from 'zod';
import { saveToLibrary } from '../utils/storage.js';
import { textContent } from '../utils/format.js';

export const saveToLibrarySchema = {
  video_id: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ)'),
  title: z.string().describe('Video title for library indexing'),
  content: z
    .string()
    .describe('Content to save: summary, notes, or extracted skill in markdown format'),
  content_type: z
    .enum(['summary', 'skill'])
    .default('summary')
    .describe(
      'Type of content: "summary" for video summaries, "skill" for extracted techniques or knowledge'
    ),
  channel: z.string().optional().describe('YouTube channel name for library indexing'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Tags for categorization and filtering (e.g., ["machine-learning", "tutorial"])'),
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

  return textContent(lines.join('\n'));
}
