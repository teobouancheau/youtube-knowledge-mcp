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
];
