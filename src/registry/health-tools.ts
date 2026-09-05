import { defineTool, type ToolDefinition } from './types.js';
import {
  checkHealthSchema,
  checkHealthOutputSchema,
  checkHealthHandler,
} from '../tools/check-health.js';

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
];
