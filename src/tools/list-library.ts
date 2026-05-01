import { z } from 'zod';
import { listLibrary } from '../utils/storage.js';
import { textContent } from '../utils/format.js';

export const listLibrarySchema = {
  tag: z
    .string()
    .optional()
    .describe(
      'Filter results by tag. Case-insensitive partial match (e.g., "ml" matches "machine-learning")'
    ),
};

export async function listLibraryHandler({ tag }: { tag?: string }) {
  const items = await listLibrary(tag ? { tag } : undefined);

  const lines: string[] = [];

  if (items.length === 0) {
    lines.push('Your library is empty.');
  } else {
    const header = tag
      ? `${items.length} item${items.length !== 1 ? 's' : ''} matching "${tag}"`
      : `${items.length} item${items.length !== 1 ? 's' : ''} in library`;
    lines.push(header);
    lines.push('');

    items.forEach((item, i) => {
      const types: string[] = [];
      if (item.hasSummary) types.push('summary');
      if (item.hasSkill) types.push('skill');

      lines.push(`${i + 1}. ${item.title}`);
      if (item.channel) {
        lines.push(`   by ${item.channel}`);
      }
      lines.push(`   ${types.join(', ')} · saved ${item.dateSaved}`);
      if (item.tags.length > 0) {
        lines.push(`   tags: ${item.tags.join(', ')}`);
      }
      lines.push('');
    });
  }

  return textContent(lines.join('\n'));
}
