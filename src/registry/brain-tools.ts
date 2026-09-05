import { defineTool, type ToolDefinition } from './types.js';
import { askBrainSchema, askBrainOutputSchema, askBrainHandler } from '../tools/ask-brain.js';
import {
  listBrainsSchema,
  listBrainsOutputSchema,
  listBrainsHandler,
  getBrainInfoSchema,
  getBrainInfoOutputSchema,
  getBrainInfoHandler,
} from '../tools/brain-info.js';
import {
  buildBrainSchema,
  buildBrainOutputSchema,
  buildBrainHandler,
} from '../tools/build-brain.js';
import {
  saveBrainProfileSchema,
  saveBrainProfileOutputSchema,
  saveBrainProfileHandler,
  deleteBrainSchema,
  deleteBrainOutputSchema,
  deleteBrainHandler,
} from '../tools/manage-brain.js';

/** Channel brains. Local like the library, and for the same reason: a brain is tens of megabytes of one user's reading, and in HTTP mode any client could fill the server's disk by naming a channel. */
export const brainTools: ToolDefinition[] = [
  defineTool({
    name: 'build_brain',
    mode: 'stdio',
    title: 'Build a Channel Brain',
    description:
      "Read a channel's videos into a searchable corpus of timestamped passages, so you can later ask what its creator has said about anything. Long-running: several hundred videos is several hundred fetches. Safe to interrupt and call again — it continues where it stopped, and on a finished brain it picks up new uploads. The since and minDurationSeconds filters describe the brain, not just the call: narrowing one discards the passages of the videos it excludes, and widening it reads them again. Ask it questions with ask_brain.",
    inputSchema: buildBrainSchema,
    outputSchema: buildBrainOutputSchema,
    annotations: {
      readOnlyHint: false,
      // A plain build only adds, but narrowing a filter drops the passages
      // of videos it excludes, and a client should be able to ask first.
      destructiveHint: true,
      // Re-running converges on the same brain rather than duplicating
      // anything: that is the same code path as resuming.
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: buildBrainHandler,
  }),
  defineTool({
    name: 'ask_brain',
    mode: 'stdio',
    title: 'Ask a Channel Brain',
    description:
      'Search everything a creator has said, across every video in their brain. Returns the passages that match, each with the timestamp and a link that opens the video at that moment, so every claim can be checked. Matches the words as spoken, so phrase the query the way the creator would say it. Requires build_brain first.',
    inputSchema: askBrainSchema,
    outputSchema: askBrainOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: askBrainHandler,
  }),
  defineTool({
    name: 'list_brains',
    mode: 'stdio',
    title: 'List Channel Brains',
    description:
      'List every channel brain built locally, with how much of each channel is indexed and whether a written profile exists.',
    inputSchema: listBrainsSchema,
    outputSchema: listBrainsOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: listBrainsHandler,
  }),
  defineTool({
    name: 'get_brain_info',
    mode: 'stdio',
    title: 'Get Channel Brain Details',
    description:
      "What a brain actually covers: how many videos were read, how many had no captions, how many are still outstanding, the channel's upload rhythm and speaking rate, and the phrases it repeats across videos. Read this before trusting an answer built from ask_brain.",
    inputSchema: getBrainInfoSchema,
    outputSchema: getBrainInfoOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: getBrainInfoHandler,
  }),
  defineTool({
    name: 'save_brain_profile',
    mode: 'stdio',
    title: 'Save a Channel Brain Profile',
    description:
      'Store a written account of a creator alongside their brain — voice, recurring arguments, how their thinking has changed. Write it from passages returned by ask_brain and cite them, because this server cannot check a claim it was handed. Overwrites any existing profile for that channel.',
    inputSchema: saveBrainProfileSchema,
    outputSchema: saveBrainProfileOutputSchema,
    annotations: {
      readOnlyHint: false,
      // Replaces the previous profile in place; the old text is not recoverable.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: saveBrainProfileHandler,
  }),
  defineTool({
    name: 'delete_brain',
    mode: 'stdio',
    title: 'Delete a Channel Brain',
    description:
      'Permanently delete a channel brain: its passages, its manifest and its profile. The transcripts it was built from stay cached, so rebuilding is much faster than the first build was.',
    inputSchema: deleteBrainSchema,
    outputSchema: deleteBrainOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: deleteBrainHandler,
  }),
];
