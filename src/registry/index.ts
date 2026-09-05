import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { brainTools } from './brain-tools.js';
import { channelTools } from './channel-tools.js';
import { healthTools } from './health-tools.js';
import { libraryTools } from './library-tools.js';
import { mediaTools } from './media-tools.js';
import { thumbnailTools } from './thumbnail-tools.js';
import { transcriptTools } from './transcript-tools.js';
import { videoTools } from './video-tools.js';
import type { ToolDefinition } from './types.js';

export type { ToolDefinition, ToolMode } from './types.js';

/** Every tool the server can offer, in the order clients see them. */
export const TOOLS: ToolDefinition[] = [
  ...videoTools,
  ...channelTools,
  ...transcriptTools,
  ...healthTools,
  ...libraryTools,
  ...mediaTools,
  ...brainTools,
  ...thumbnailTools,
];

/** Registers the tools the transport may carry: everything on stdio, remote-safe ones over HTTP. */
export function registerTools(server: McpServer, mode: 'stdio' | 'http'): void {
  for (const tool of TOOLS) {
    if (tool.mode === 'all' || mode === 'stdio') tool.register(server, mode);
  }
}
