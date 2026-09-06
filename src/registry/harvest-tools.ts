import { defineTool, type ToolDefinition } from './types.js';
import {
  harvestChannelSchema,
  harvestChannelOutputSchema,
  harvestChannelHandler,
} from '../tools/harvest-channel.js';
import {
  getCoverageSchema,
  getCoverageOutputSchema,
  getCoverageHandler,
} from '../tools/get-coverage.js';
import {
  harvestCommentsSchema,
  harvestCommentsOutputSchema,
  harvestCommentsHandler,
} from '../tools/harvest-comments.js';
import {
  queryCommentsSchema,
  queryCommentsOutputSchema,
  queryCommentsHandler,
} from '../tools/query-comments.js';

/**
 * Exhaustive extraction and the receipts that keep it honest.
 *
 * All stdio-only: they write to the local store, which a channel harvest
 * measures in gigabytes, and no remote caller should be able to fill the
 * operator's disk by naming a channel.
 */
export const harvestTools: ToolDefinition[] = [
  defineTool({
    name: 'harvest_channel',
    mode: 'stdio',
    title: 'Harvest Channel Catalogue',
    description:
      'Catalogue every video a channel lists, across all of its tabs (videos, shorts, streams, releases, podcasts), into the local store. Returns a completeness receipt saying whether the catalogue is provably whole. Call it again to continue: videos are keyed on their id, so a re-run costs requests and never data.',
    inputSchema: harvestChannelSchema,
    outputSchema: harvestChannelOutputSchema,
    annotations: {
      readOnlyHint: false,
      // Only ever adds and upserts; `have` never decreases. Deleting is
      // prune_harvest's job alone.
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: harvestChannelHandler,
  }),
  defineTool({
    name: 'get_coverage',
    mode: 'stdio',
    title: 'Get Harvest Coverage',
    description:
      'Report what this server can actually prove it holds: one completeness receipt per harvested target, plus whether ANY of them is incomplete. Reads only the local store and never contacts YouTube, so it is cheap to call before making any claim about the data. Check anyIncomplete before describing anything as a full history.',
    inputSchema: getCoverageSchema,
    outputSchema: getCoverageOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: getCoverageHandler,
  }),
  defineTool({
    name: 'harvest_comments',
    mode: 'stdio',
    title: 'Harvest Video Comments',
    description:
      "Extract a video's comments and replies into the local store, with a completeness receipt. There is no comment cursor — an interrupted run keeps nothing for that video, so to get more, run it again with a larger maxComments. Re-running upserts on the comment id, so it costs requests and never data.",
    inputSchema: harvestCommentsSchema,
    outputSchema: harvestCommentsOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: harvestCommentsHandler,
  }),
  defineTool({
    name: 'query_comments',
    mode: 'stdio',
    title: 'Query Harvested Comments',
    description:
      'Search comments already in the local store, with full-text matching, real pagination and thread lookup. Never contacts YouTube. The total counts rows in the store, not the number of comments the videos have — the coverage receipts alongside it say which videos are only partly harvested.',
    inputSchema: queryCommentsSchema,
    outputSchema: queryCommentsOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: queryCommentsHandler,
  }),
];
