import { defineTool, type ToolDefinition } from './types.js';
import {
  harvestDetailsSchema,
  harvestDetailsOutputSchema,
  harvestDetailsHandler,
} from '../tools/harvest-details.js';
import {
  checkNewUploadsSchema,
  checkNewUploadsOutputSchema,
  checkNewUploadsHandler,
} from '../tools/check-new-uploads.js';
import {
  exportDataSchema,
  exportDataOutputSchema,
  exportDataHandler,
} from '../tools/export-data.js';

/**
 * Working with the harvested store once it holds something: reading each video in full,
 * noticing what a channel published since, and taking the data out.
 *
 * All stdio-only, for the reason the harvest tools are: they read and write the local store.
 */
export const storeTools: ToolDefinition[] = [
  defineTool({
    name: 'harvest_details',
    mode: 'stdio',
    title: 'Harvest Video Details',
    description:
      'Read the full record of every video in a catalogued channel and keep it in the local store: category, licence, language, availability, the replay heatmap and the counts YouTube states. Works a batch at a time and continues where it stopped; a video is read once. Needs harvest_channel first. Stops early, keeping what it read, if YouTube starts refusing. Returns a completeness receipt that is complete only when every video of a complete catalogue has been read.',
    inputSchema: harvestDetailsSchema,
    outputSchema: harvestDetailsOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: harvestDetailsHandler,
  }),
  defineTool({
    name: 'check_new_uploads',
    mode: 'stdio',
    title: 'Check a Channel for New Uploads',
    description:
      'Find what a channel has published since it was catalogued: compares the newest videos of each tab with the local catalogue and names the ones it has never seen, with links. Writes nothing, so what is new can be inspected before it is added with harvest_channel. Runs when asked; nothing watches the channel. Needs harvest_channel first.',
    inputSchema: checkNewUploadsSchema,
    outputSchema: checkNewUploadsOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: checkNewUploadsHandler,
  }),
  defineTool({
    name: 'export_data',
    mode: 'stdio',
    title: 'Export Harvested Data',
    description:
      'Write harvested videos or comments from the local store to a JSON, CSV or Markdown file. The file carries the completeness receipts for its rows (inside it for JSON and Markdown, in a .coverage.json beside it for CSV), so it cannot be read as the full history when it is not. CSV text is defused against spreadsheet formula injection. Truncated by limit; the result says how many rows were left out.',
    inputSchema: exportDataSchema,
    outputSchema: exportDataOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Deterministic path, overwritten on a repeat, like the other writers.
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: exportDataHandler,
  }),
];
