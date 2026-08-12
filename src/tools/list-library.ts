import { z } from 'zod';
import { listLibrary } from '../utils/storage.js';
import { pageInfo, toolResult } from '../utils/format.js';
import { libraryMetadataSchema, paginationShape } from '../schemas.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const listLibrarySchema = {
  tag: z
    .string()
    .optional()
    .describe(
      'Filter results by tag. Case-insensitive partial match (e.g., "ml" matches "machine-learning")'
    ),
};

export const listLibraryOutputSchema = {
  items: z.array(libraryMetadataSchema),
  ...paginationShape,
};

export async function listLibraryHandler({ tag }: { tag?: string }): Promise<CallToolResult> {
  const items = await listLibrary(tag ? { tag } : undefined);
  const structured = { items, ...pageInfo(items.length, items.length) };

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

  return toolResult(lines.join('\n'), structured);
}
