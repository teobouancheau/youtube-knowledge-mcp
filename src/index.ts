import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { formatPreflightReport, runPreflight } from './utils/preflight.js';
import { startHttp } from './http.js';
import { serverVersion } from './utils/version.js';
import { describeYtDlpEnv, readYtDlpEnv } from './utils/ytdlp-env.js';
import { registerPrompts } from './prompts.js';
import { registerTools } from './registry/index.js';
import { registerResources } from './resources.js';

const SERVER_INSTRUCTIONS = `YouTube Knowledge MCP provides tools to search, analyze, and extract knowledge from YouTube videos.

Recommended workflows:
- Use search_videos to find videos by topic, then get_transcript for deep analysis
- Use get_chapters to understand video structure before reading the full transcript
- Use get_comments for audience sentiment and discussion highlights
- Use get_channel_info to contextualize a creator's content
- Combine transcript + chapters for structured, timestamped summaries

All tools accept YouTube video IDs (e.g., dQw4w9WgXcQ) or full URLs.`;

/**
 * Build a fully configured server.
 *
 * Exported so the test suite can drive it over an in-memory transport as a real
 * MCP client, rather than only testing handlers in isolation.
 */
export function createServer(mode: 'stdio' | 'http' = 'stdio'): McpServer {
  const server = new McpServer(
    { name: 'youtube-knowledge-mcp', version: serverVersion() },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } }
  );

  registerTools(server, mode);
  registerPrompts(server, mode);
  registerResources(server, mode);

  return server;
}

/** An explicit flag wins over the environment, so a launcher can always override. */
export function getTransportMode(): 'stdio' | 'http' {
  if (process.argv.includes('--http')) return 'http';
  if (process.argv.includes('--stdio')) return 'stdio';
  if (process.env.MCP_MODE === 'http') return 'http';
  return 'stdio';
}

async function startStdio(): Promise<void> {
  const server = createServer('stdio');
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Report missing or stale external binaries at boot.
 *
 * Deliberately non-fatal: the server still starts and still lists its tools, so
 * a client can call check_health and be told exactly what to install. Exiting
 * here would surface as an opaque "server failed to start" in the client.
 */
export async function announcePreflight(): Promise<void> {
  const report = await runPreflight();
  if (report.ok && !report.ytDlp.warning && report.ffmpeg.installed) return;

  console.error(formatPreflightReport(report));
}

export async function main(): Promise<void> {
  const mode = getTransportMode();
  // Validated once, here, so a misspelt browser name or an unreadable cookies
  // file stops the server at boot rather than failing the first tool call.
  const session = readYtDlpEnv();
  if (session.cookies !== 'none' || session.proxy) console.error(describeYtDlpEnv(session));
  await announcePreflight();

  if (mode === 'http') {
    startHttp(createServer);
  } else {
    await startStdio();
  }
}

// Nothing starts on import: the test suite imports this module, and the only
// caller of `main()` is `cli.ts`, the file the `bin` entry points at.
