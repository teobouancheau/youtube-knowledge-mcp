import { defineTool, type ToolDefinition } from './types.js';
import {
  getLibraryItemSchema,
  getLibraryItemOutputSchema,
  getLibraryItemHandler,
  searchLibrarySchema,
  searchLibraryOutputSchema,
  searchLibraryHandler,
  updateLibraryTagsSchema,
  updateLibraryTagsOutputSchema,
  updateLibraryTagsHandler,
  deleteLibraryItemSchema,
  deleteLibraryItemOutputSchema,
  deleteLibraryItemHandler,
  rebuildLibraryIndexSchema,
  rebuildLibraryIndexOutputSchema,
  rebuildLibraryIndexHandler,
} from '../tools/library.js';
import {
  listLibrarySchema,
  listLibraryOutputSchema,
  listLibraryHandler,
} from '../tools/list-library.js';
import {
  saveToLibrarySchema,
  saveToLibraryOutputSchema,
  saveToLibraryHandler,
} from '../tools/save-to-library.js';

/** The local knowledge library. Local only: these write under the home directory. */
export const libraryTools: ToolDefinition[] = [
  defineTool({
    name: 'save_to_library',
    mode: 'stdio',
    title: 'Save to YouTube Knowledge Library',
    description:
      'Save a summary or skill note to the local YouTube knowledge library. Overwrites existing content of the same type for the same video. Returns the saved file path.',
    inputSchema: saveToLibrarySchema,
    outputSchema: saveToLibraryOutputSchema,
    annotations: {
      readOnlyHint: false,
      // Overwrites an existing note of the same type in place, which is a
      // destructive update: the previous content is not recoverable.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: saveToLibraryHandler,
  }),
  defineTool({
    name: 'list_library',
    mode: 'stdio',
    title: 'List YouTube Knowledge Library',
    description:
      'List all saved items in the local YouTube knowledge library. Returns titles, channels, content types, tags, and save dates. Optionally filter by tag. Sorted by most recently saved.',
    inputSchema: listLibrarySchema,
    outputSchema: listLibraryOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: listLibraryHandler,
  }),
  defineTool({
    name: 'get_library_item',
    mode: 'stdio',
    title: 'Read a Saved Library Item',
    description:
      'Read back a summary or skill note previously saved with save_to_library. Returns the markdown content plus the saved metadata.',
    inputSchema: getLibraryItemSchema,
    outputSchema: getLibraryItemOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: getLibraryItemHandler,
  }),
  defineTool({
    name: 'search_library',
    mode: 'stdio',
    title: 'Search the Knowledge Library',
    description:
      'Full-text search across every saved summary and skill note, ranked by relevance. Returns matching excerpts with the video IDs needed to read the full note.',
    inputSchema: searchLibrarySchema,
    outputSchema: searchLibraryOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: searchLibraryHandler,
  }),
  defineTool({
    name: 'update_library_tags',
    mode: 'stdio',
    title: 'Update Library Tags',
    description:
      'Add, remove or replace the tags on a saved library item. Tags are how list_library filters, so this is the way to reorganize a growing library. The replace parameter discards all existing tags.',
    inputSchema: updateLibraryTagsSchema,
    outputSchema: updateLibraryTagsOutputSchema,
    annotations: {
      readOnlyHint: false,
      // The replace parameter discards every existing tag.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: updateLibraryTagsHandler,
  }),
  defineTool({
    name: 'delete_library_item',
    mode: 'stdio',
    title: 'Delete a Library Item',
    description:
      'Permanently delete a saved summary or skill note, or the entire library entry for a video. This removes files from disk and cannot be undone.',
    inputSchema: deleteLibraryItemSchema,
    outputSchema: deleteLibraryItemOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: deleteLibraryItemHandler,
  }),
  defineTool({
    name: 'rebuild_library_index',
    mode: 'stdio',
    title: 'Rebuild the Library Search Index',
    description:
      'Rebuild the full-text search index from the notes on disk. Use this if search_library results look stale or incomplete, for example after editing files by hand.',
    inputSchema: rebuildLibraryIndexSchema,
    outputSchema: rebuildLibraryIndexOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: rebuildLibraryIndexHandler,
  }),
];
