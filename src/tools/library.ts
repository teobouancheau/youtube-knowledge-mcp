import { z } from 'zod';
import {
  deleteLibraryItem,
  getLibraryItem,
  rebuildSearchIndex,
  searchLibrary,
  updateLibraryTags,
} from '../utils/storage.js';
import { pageInfo, toolResult } from '../utils/format.js';
import { VIDEO_ID_PATTERN } from '../utils/validate.js';
import { libraryMetadataSchema, librarySearchHitSchema, paginationShape } from '../schemas.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Reading, searching and curating the local library.
 *
 * Until now the library was write-only: save_to_library wrote markdown that no
 * tool could read back, and list_library could only filter by tag substring.
 */

// -- get_library_item ----------------------------------------------------

export const getLibraryItemSchema = {
  videoId: z
    .string()
    .regex(VIDEO_ID_PATTERN, 'an 11-character YouTube video id')
    .describe('Video ID of the saved item, as shown by list_library'),
  contentType: z
    .enum(['summary', 'skill'])
    .optional()
    .describe('Which note to read. Omit to return both.'),
};

export const getLibraryItemOutputSchema = {
  metadata: libraryMetadataSchema,
  summary: z.string().optional(),
  skill: z.string().optional(),
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

  return toolResult(lines.join('\n'), {
    metadata,
    ...(item.summary === undefined ? {} : { summary: item.summary }),
    ...(item.skill === undefined ? {} : { skill: item.skill }),
  });
}

// -- search_library ------------------------------------------------------

export const searchLibrarySchema = {
  query: z
    .string()
    .min(1)
    .describe('Words or phrase to search for across saved summaries and skills'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum results. Default: 10'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Skip this many of the ranked results, for paging. Default: 0'),
};

export const searchLibraryOutputSchema = {
  query: z.string(),
  hits: z.array(librarySearchHitSchema),
  ...paginationShape,
};

export async function searchLibraryHandler({
  query,
  limit,
  offset,
}: {
  query: string;
  limit: number;
  offset: number;
}): Promise<CallToolResult> {
  const { hits, total } = await searchLibrary(query, limit, offset);
  const structured = {
    query,
    hits: hits.map(({ id: _id, ...hit }) => hit),
    ...pageInfo({ total, count: hits.length, offset }),
  };

  if (hits.length === 0) {
    return toolResult(
      [
        `No saved notes match "${query}".`,
        '',
        'Try different words, or call list_library to see everything saved.',
      ].join('\n'),
      structured
    );
  }

  const lines: string[] = [`${hits.length} of ${total} result${total === 1 ? '' : 's'}`, ''];

  for (const hit of hits) {
    lines.push(`${hit.title} (${hit.kind})`);
    lines.push(`  ${hit.excerpt}`);
    lines.push(`  get_library_item videoId=${hit.videoId} contentType=${hit.kind}`);
    lines.push('');
  }

  return toolResult(lines.join('\n').trimEnd(), structured);
}

// -- delete_library_item -------------------------------------------------

export const deleteLibraryItemSchema = {
  videoId: z
    .string()
    .regex(VIDEO_ID_PATTERN, 'an 11-character YouTube video id')
    .describe('Video ID of the saved item to delete'),
  contentType: z
    .enum(['summary', 'skill'])
    .optional()
    .describe('Delete only this note. Omit to delete the entire library entry.'),
};

export const deleteLibraryItemOutputSchema = {
  videoId: z.string(),
  deleted: z.array(z.string()),
};

export async function deleteLibraryItemHandler({
  videoId,
  contentType,
}: {
  videoId: string;
  contentType?: 'summary' | 'skill';
}): Promise<CallToolResult> {
  const { deleted } = await deleteLibraryItem(videoId, contentType);
  return toolResult(`Deleted ${deleted.join(', ')} for ${videoId}.`, { videoId, deleted });
}

// -- update_library_tags -------------------------------------------------

export const updateLibraryTagsSchema = {
  videoId: z
    .string()
    .regex(VIDEO_ID_PATTERN, 'an 11-character YouTube video id')
    .describe('Video ID of the saved item to retag'),
  add: z.array(z.string()).optional().describe('Tags to add'),
  remove: z.array(z.string()).optional().describe('Tags to remove, matched case-insensitively'),
  replace: z
    .array(z.string())
    .optional()
    .describe('Replace all existing tags with this list. Applied before add and remove.'),
};

export const updateLibraryTagsOutputSchema = libraryMetadataSchema.shape;

export async function updateLibraryTagsHandler(args: {
  videoId: string;
  add?: string[];
  remove?: string[];
  replace?: string[];
}): Promise<CallToolResult> {
  const updated = await updateLibraryTags(args.videoId, args);
  return toolResult(
    [updated.title, updated.tags.length > 0 ? `tags: ${updated.tags.join(', ')}` : 'no tags'].join(
      '\n'
    ),
    { ...updated }
  );
}

// -- rebuild_library_index -----------------------------------------------

export const rebuildLibraryIndexSchema = {};

export const rebuildLibraryIndexOutputSchema = { documents: z.number().int() };

export async function rebuildLibraryIndexHandler(): Promise<CallToolResult> {
  const { documents } = await rebuildSearchIndex();
  return toolResult(`Rebuilt the search index over ${documents} saved note(s).`, { documents });
}
