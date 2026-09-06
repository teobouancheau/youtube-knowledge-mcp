import { defineTool, type ToolDefinition } from './types.js';
import {
  checkHealthSchema,
  checkHealthOutputSchema,
  checkHealthHandler,
} from '../tools/check-health.js';
import {
  repairStoreSchema,
  repairStoreOutputSchema,
  repairStoreHandler,
} from '../tools/repair-store.js';

/** Diagnostics. Remote-safe. */
export const healthTools: ToolDefinition[] = [
  defineTool({
    name: 'check_health',
    mode: 'all',
    title: 'Check Server Health',
    description:
      'Report whether yt-dlp and ffmpeg are installed, their versions, and whether yt-dlp is stale. Call this first when tools start failing unexpectedly — an outdated yt-dlp is the most common cause.',
    inputSchema: checkHealthSchema,
    outputSchema: checkHealthOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: checkHealthHandler,
  }),
  defineTool({
    name: 'repair_store',
    // Local-only: it renames a file in the user's data directory, and every
    // tool that writes to disk is stdio-only.
    mode: 'stdio',
    title: 'Repair Harvested Store',
    description:
      'Check the harvested store and, if it is damaged, move it aside and start a fresh one. The damaged file is kept, never deleted. Call this when a harvest tool reports STORE_CORRUPT.',
    inputSchema: repairStoreSchema,
    outputSchema: repairStoreOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: repairStoreHandler,
  }),
];
