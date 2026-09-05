import { z } from 'zod';
import { saveToLibrary } from '../utils/storage.js';
import { fileResult } from '../utils/format.js';
import { VIDEO_ID_PATTERN } from '../utils/validate.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const saveToLibrarySchema = {
  videoId: z
    .string()
    .regex(VIDEO_ID_PATTERN, 'an 11-character YouTube video id')
    .describe('YouTube video ID (e.g., dQw4w9WgXcQ)'),
  title: z.string().describe('Video title for library indexing'),
  content: z
    .string()
    .describe('Content to save: summary, notes, or extracted skill in markdown format'),
  contentType: z
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

export const saveToLibraryOutputSchema = {
  videoId: z.string(),
  title: z.string(),
  contentType: z.enum(['summary', 'skill']),
  filePath: z.string(),
  tags: z.array(z.string()),
};

export async function saveToLibraryHandler({
  videoId,
  title,
  content,
  contentType,
  channel,
  tags,
}: {
  videoId: string;
  title: string;
  content: string;
  contentType: 'summary' | 'skill';
  channel?: string;
  tags?: string[];
}): Promise<CallToolResult> {
  const result = await saveToLibrary({
    videoId,
    title,
    content,
    contentType,
    channel,
    tags,
  });

  const lines: string[] = [`Saved ${contentType} to library`, '', title];

  if (channel) {
    lines.push(`by ${channel}`);
  }

  if (tags && tags.length > 0) {
    lines.push(`tags: ${tags.join(', ')}`);
  }

  lines.push('');
  lines.push(result.path);

  return fileResult(
    lines.join('\n'),
    { videoId, title, contentType, filePath: result.path, tags: tags ?? [] },
    { path: result.path, name: `${title} (${contentType})`, mimeType: 'text/markdown' }
  );
}
