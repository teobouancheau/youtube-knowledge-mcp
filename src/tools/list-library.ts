import { z } from 'zod';
import { listLibrary } from '../utils/storage.js';

export const listLibrarySchema = {
  tag: z.string().optional().describe('Filter by tag (partial match)'),
};

export async function listLibraryHandler({ tag }: { tag?: string }) {
  const items = await listLibrary(tag ? { tag } : undefined);

  const output = {
    count: items.length,
    items: items.map((item) => ({
      video_id: item.videoId,
      title: item.title,
      channel: item.channel,
      tags: item.tags,
      date_saved: item.dateSaved,
      has_summary: item.hasSummary,
      has_skill: item.hasSkill,
      url: item.url,
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
