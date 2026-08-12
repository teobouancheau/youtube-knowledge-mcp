#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { fetchVideosSchema, fetchVideosHandler } from './tools/fetch-videos.js';
import { getVideoInfoSchema, getVideoInfoHandler } from './tools/get-video-info.js';
import { getTranscriptSchema, getTranscriptHandler } from './tools/get-transcript.js';
import { searchVideosSchema, searchVideosHandler } from './tools/search-videos.js';
import { getChaptersSchema, getChaptersHandler } from './tools/get-chapters.js';
import { getCommentsSchema, getCommentsHandler } from './tools/get-comments.js';
import { getChannelInfoSchema, getChannelInfoHandler } from './tools/get-channel-info.js';
import { searchChannelsSchema, searchChannelsHandler } from './tools/search-channels.js';
import { getPlaylistInfoSchema, getPlaylistInfoHandler } from './tools/get-playlist-info.js';
import { saveToLibrarySchema, saveToLibraryHandler } from './tools/save-to-library.js';
import { listLibrarySchema, listLibraryHandler } from './tools/list-library.js';
import {
  listFormatsSchema,
  listFormatsHandler,
  downloadVideoSchema,
  downloadVideoHandler,
} from './tools/download-video.js';
import { healthCheckSchema, healthCheckHandler } from './tools/health-check.js';
import { runWithRequestContext } from './utils/context.js';
import { toToolError } from './utils/errors.js';
import { formatPreflightReport, runPreflight } from './utils/preflight.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
  version: string;
};

const SERVER_INSTRUCTIONS = `YouTube Knowledge MCP provides tools to search, analyze, and extract knowledge from YouTube videos.

Recommended workflows:
- Use search_videos to find videos by topic, then get_transcript for deep analysis
- Use get_chapters to understand video structure before reading the full transcript
- Use get_comments for audience sentiment and discussion highlights
- Use get_channel_info to contextualize a creator's content
- Combine transcript + chapters for structured, timestamped summaries

All tools accept YouTube video IDs (e.g., dQw4w9WgXcQ) or full URLs.`;

/**
 * Wrap a tool handler so that every call gets a request context and no call can
 * throw out of the server.
 *
 * Two things happen here, once, instead of thirteen times in thirteen files:
 * the MCP request's AbortSignal is published to the request context so an
 * in-flight yt-dlp is killed when the client cancels, and anything thrown is
 * rendered as an `isError` result carrying an actionable message rather than a
 * raw stack trace or yt-dlp command line.
 */
function guarded<H extends (...args: never[]) => Promise<CallToolResult>>(handler: H): H {
  const invoke = handler as unknown as (...args: unknown[]) => Promise<CallToolResult>;

  const wrapped = async (...args: unknown[]): Promise<CallToolResult> => {
    // The SDK always passes RequestHandlerExtra last, whatever the tool's arity.
    const extra: unknown = args[args.length - 1];
    const signal =
      typeof extra === 'object' &&
      extra !== null &&
      'signal' in extra &&
      extra.signal instanceof AbortSignal
        ? extra.signal
        : undefined;

    return runWithRequestContext({ signal }, async () => {
      try {
        return await invoke(...args);
      } catch (error) {
        return toToolError(error);
      }
    });
  };

  return wrapped as unknown as H;
}

function createServer(mode: 'stdio' | 'http' = 'stdio'): McpServer {
  const server = new McpServer(
    { name: 'youtube-knowledge-mcp', version: pkg.version },
    { instructions: SERVER_INSTRUCTIONS }
  );

  // -- Remote-safe tools (registered in all modes) --

  server.registerTool(
    'search_videos',
    {
      title: 'Search YouTube Videos',
      description:
        'Search YouTube for videos by keyword or phrase. Returns video IDs, titles, durations, channels, view counts, and URLs. Results sorted by relevance.',
      inputSchema: searchVideosSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(searchVideosHandler)
  );

  server.registerTool(
    'fetch_videos',
    {
      title: 'Fetch YouTube Videos',
      description:
        'List videos from a YouTube playlist or channel. Returns video IDs, titles, durations, upload dates, and URLs. Sorted by playlist or channel order.',
      inputSchema: fetchVideosSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(fetchVideosHandler)
  );

  server.registerTool(
    'get_video_info',
    {
      title: 'Get YouTube Video Info',
      description:
        'Get detailed metadata for a single YouTube video. Returns title, channel, duration, upload date, view count, like count, comment count, description, tags, and thumbnail URL.',
      inputSchema: getVideoInfoSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(getVideoInfoHandler)
  );

  server.registerTool(
    'get_transcript',
    {
      title: 'Get YouTube Video Transcript',
      description:
        'Extract the full transcript from a YouTube video. Supports auto-generated and manual captions. Returns plain text with word count and detected language. Results are cached locally.',
      inputSchema: getTranscriptSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(getTranscriptHandler)
  );

  server.registerTool(
    'get_chapters',
    {
      title: 'Get YouTube Video Chapters',
      description:
        'Extract chapter markers and timestamps from a YouTube video. Returns chapter titles with start and end times. Not all videos have chapters. Returns empty list if none found.',
      inputSchema: getChaptersSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(getChaptersHandler)
  );

  server.registerTool(
    'get_comments',
    {
      title: 'Get YouTube Video Comments',
      description:
        'Get top comments from a YouTube video sorted by popularity. Returns author, text, like count, and pinned status. Only top-level comments, no replies.',
      inputSchema: getCommentsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(getCommentsHandler)
  );

  server.registerTool(
    'get_channel_info',
    {
      title: 'Get YouTube Channel Info',
      description:
        'Get metadata for a YouTube channel. Returns channel name, handle, subscriber count, description, and channel URL.',
      inputSchema: getChannelInfoSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(getChannelInfoHandler)
  );

  server.registerTool(
    'search_channels',
    {
      title: 'Search YouTube Channels',
      description:
        'Search YouTube for channels by keyword or phrase. Returns channel names, handles, subscriber counts, descriptions, and URLs.',
      inputSchema: searchChannelsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(searchChannelsHandler)
  );

  server.registerTool(
    'get_playlist_info',
    {
      title: 'Get YouTube Playlist Info',
      description:
        'Get metadata for a YouTube playlist. Returns title, channel, video count, last updated date, and description.',
      inputSchema: getPlaylistInfoSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(getPlaylistInfoHandler)
  );

  server.registerTool(
    'list_formats',
    {
      title: 'List YouTube Video Formats',
      description:
        'List all available download formats for a YouTube video. Returns format IDs, extensions, resolutions, FPS, codecs, and file sizes. Grouped by video+audio, video-only, and audio-only.',
      inputSchema: listFormatsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(listFormatsHandler)
  );

  server.registerTool(
    'health_check',
    {
      title: 'Check Server Health',
      description:
        'Report whether yt-dlp and ffmpeg are installed, their versions, and whether yt-dlp is stale. Call this first when tools start failing unexpectedly — an outdated yt-dlp is the most common cause.',
      inputSchema: healthCheckSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(healthCheckHandler)
  );

  // -- Local-only tools (stdio mode only) --

  if (mode === 'stdio') {
    server.registerTool(
      'save_to_library',
      {
        title: 'Save to YouTube Knowledge Library',
        description:
          'Save a summary or skill note to the local YouTube knowledge library. Overwrites existing content of the same type for the same video. Returns the saved file path.',
        inputSchema: saveToLibrarySchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(saveToLibraryHandler)
    );

    server.registerTool(
      'list_library',
      {
        title: 'List YouTube Knowledge Library',
        description:
          'List all saved items in the local YouTube knowledge library. Returns titles, channels, content types, tags, and save dates. Optionally filter by tag. Sorted by most recently saved.',
        inputSchema: listLibrarySchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(listLibraryHandler)
    );

    server.registerTool(
      'download_video',
      {
        title: 'Download YouTube Video',
        description:
          'Download a YouTube video to local disk. Use the quality parameter for automatic format selection with smart fallbacks, or formatId for a specific format from list_formats. Returns the downloaded file path, title, and format details.',
        inputSchema: downloadVideoSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      guarded(downloadVideoHandler)
    );
  }

  return server;
}

function getTransportMode(): 'stdio' | 'http' {
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

// Rate limiting for public HTTP server
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

function startHttp(): void {
  const port = parseInt(process.env.PORT ?? '3000', 10);

  // Cleanup stale rate limit entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimits) {
      if (now > entry.resetAt) rateLimits.delete(ip);
    }
  }, 300_000);

  const app: Express = createMcpExpressApp({ host: '0.0.0.0' });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    // Rate limiting
    const clientIp =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      'unknown';
    if (!checkRateLimit(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Rate limit exceeded' },
          id: null,
        })
      );
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      const existingTransport = sessionId ? transports.get(sessionId) : undefined;
      if (existingTransport) {
        await existingTransport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
        };

        const server = createServer('http');
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        })
      );
    } catch (error: unknown) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          })
        );
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid or missing session ID');
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid or missing session ID');
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.get('/health', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  app.listen(port, () => {
    console.error(`MCP Streamable HTTP server listening on port ${port}`);
    console.error(`MCP endpoint: http://localhost:${port}/mcp`);
  });

  process.on('SIGINT', () => {
    const closeAll = async (): Promise<void> => {
      for (const [sid, transport] of transports) {
        await transport.close();
        transports.delete(sid);
      }
      process.exit(0);
    };
    void closeAll();
  });
}

/**
 * Report missing or stale external binaries at boot.
 *
 * Deliberately non-fatal: the server still starts and still lists its tools, so
 * a client can call health_check and be told exactly what to install. Exiting
 * here would surface as an opaque "server failed to start" in the client.
 */
async function announcePreflight(): Promise<void> {
  const report = await runPreflight();
  if (report.ok && !report.ytDlp.warning && report.ffmpeg.installed) return;

  console.error(formatPreflightReport(report));
}

async function main(): Promise<void> {
  const mode = getTransportMode();
  await announcePreflight();

  if (mode === 'http') {
    startHttp();
  } else {
    await startStdio();
  }
}

main().catch((error: unknown) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
