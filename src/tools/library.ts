import { z } from 'zod';
import {
  deleteLibraryItem,
  getLibraryItem,
  rebuildSearchIndex,
  searchLibrary,
  updateLibraryTags,
} from '../utils/storage.js';
import { textContent } from '../utils/format.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Reading, searching and curating the local library.
 *
 * Until now the library was write-only: save_to_library wrote markdown that no
 * tool could read back, and list_library could only filter by tag substring.
 */

// -- get_library_item ----------------------------------------------------

export const getLibraryItemSchema = {
  videoId: z.string().describe('Video ID of the saved item, as shown by list_library'),
  contentType: z
    .enum(['summary', 'skill'])
    .optional()
    .describe('Which note to read. Omit to return both.'),
};

export async function getLibraryItemHandler({
  videoId,
  contentType,
}: {
  videoId: string;
  contentType?: 'summary' | 'skill';
}): Promise<CallToolResult> {
  const item = await getLibraryItem(videoId, contentType);
  const { metadata } = item;

  const lines: string[] = [
    metadata.title,
    metadata.channel ? `by ${metadata.channel}` : '',
    metadata.url,
    `saved ${metadata.dateSaved.slice(0, 10)}`,
    metadata.tags.length > 0 ? `tags: ${metadata.tags.join(', ')}` : '',
  ].filter(Boolean);

  if (item.summary !== undefined) lines.push('', '## Summary', '', item.summary);
  if (item.skill !== undefined) lines.push('', '## Skill', '', item.skill);

  return textContent(lines.join('\n'));
}

// -- search_library ------------------------------------------------------

export const searchLibrarySchema = {
  query: z
    .string()
    .min(1)
    .describe('Words or phrase to search for across saved summaries and skills'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum results. Default: 10'),
};

export async function searchLibraryHandler({
  query,
  limit,
}: {
  query: string;
  limit: number;
}): Promise<CallToolResult> {
  const hits = await searchLibrary(query, limit);

  if (hits.length === 0) {
    return textContent(
      [
        `No saved notes match "${query}".`,
        '',
        'Try different words, or call list_library to see everything saved.',
      ].join('\n')
    );
  }

  const lines: string[] = [`${hits.length} result${hits.length === 1 ? '' : 's'}`, ''];

  for (const hit of hits) {
    lines.push(`${hit.title} (${hit.kind})`);
    lines.push(`  ${hit.excerpt}`);
    lines.push(`  get_library_item videoId=${hit.videoId} contentType=${hit.kind}`);
    lines.push('');
  }

  return textContent(lines.join('\n').trimEnd());
}

// -- delete_library_item -------------------------------------------------

export const deleteLibraryItemSchema = {
  videoId: z.string().describe('Video ID of the saved item to delete'),
  contentType: z
    .enum(['summary', 'skill'])
    .optional()
    .describe('Delete only this note. Omit to delete the entire library entry.'),
};

export async function deleteLibraryItemHandler({
  videoId,
  contentType,
}: {
  videoId: string;
  contentType?: 'summary' | 'skill';
}): Promise<CallToolResult> {
  const { deleted } = await deleteLibraryItem(videoId, contentType);
  return textContent(`Deleted ${deleted.join(', ')} for ${videoId}.`);
}

// -- update_library_tags -------------------------------------------------

export const updateLibraryTagsSchema = {
  videoId: z.string().describe('Video ID of the saved item to retag'),
  add: z.array(z.string()).optional().describe('Tags to add'),
  remove: z.array(z.string()).optional().describe('Tags to remove, matched case-insensitively'),
  replace: z
    .array(z.string())
    .optional()
    .describe('Replace all existing tags with this list. Applied before add and remove.'),
};

export async function updateLibraryTagsHandler(args: {
  videoId: string;
  add?: string[];
  remove?: string[];
  replace?: string[];
}): Promise<CallToolResult> {
  const updated = await updateLibraryTags(args.videoId, args);
  return textContent(
    [updated.title, updated.tags.length > 0 ? `tags: ${updated.tags.join(', ')}` : 'no tags'].join(
      '\n'
    )
  );
}

// -- rebuild_library_index -----------------------------------------------

export const rebuildLibraryIndexSchema = {};

export async function rebuildLibraryIndexHandler(): Promise<CallToolResult> {
  const { documents } = await rebuildSearchIndex();
  return textContent(`Rebuilt the search index over ${documents} saved note(s).`);
}
