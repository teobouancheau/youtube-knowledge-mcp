#!/usr/bin/env node

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { fetchVideosSchema, fetchVideosHandler } from './tools/fetch-videos.js';
import { getVideoInfoSchema, getVideoInfoHandler } from './tools/get-video-info.js';
import { getTranscriptSchema, getTranscriptHandler } from './tools/get-transcript.js';
import { saveToLibrarySchema, saveToLibraryHandler } from './tools/save-to-library.js';
import { listLibrarySchema, listLibraryHandler } from './tools/list-library.js';
import {
  listFormatsSchema,
  listFormatsHandler,
  downloadVideoSchema,
  downloadVideoHandler,
} from './tools/download-video.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
  version: string;
};

const server = new McpServer({
  name: 'youtube-knowledge-mcp',
  version: pkg.version,
});

// Tool 1: Fetch videos from playlist or channel
server.registerTool(
  'youtube_fetch_videos',
  {
    title: 'Fetch YouTube Videos',
    description:
      'List videos from a YouTube playlist or channel. Returns video IDs, titles, durations, and dates.',
    inputSchema: fetchVideosSchema,
  },
  fetchVideosHandler
);

// Tool 2: Get video info
server.registerTool(
  'youtube_get_video_info',
  {
    title: 'Get Video Info',
    description:
      'Get detailed metadata for a YouTube video including title, channel, duration, description, and tags.',
    inputSchema: getVideoInfoSchema,
  },
  getVideoInfoHandler
);

// Tool 3: Get transcript
server.registerTool(
  'youtube_get_transcript',
  {
    title: 'Get Video Transcript',
    description:
      'Extract the transcript/subtitles from a YouTube video. Supports auto-generated and manual captions.',
    inputSchema: getTranscriptSchema,
  },
  getTranscriptHandler
);

// Tool 4: Save to library
server.registerTool(
  'youtube_save_to_library',
  {
    title: 'Save to Library',
    description: 'Save a summary, notes, or skill to your personal YouTube knowledge library.',
    inputSchema: saveToLibrarySchema,
  },
  saveToLibraryHandler
);

// Tool 5: List library
server.registerTool(
  'youtube_list_library',
  {
    title: 'List Library',
    description:
      'List all saved items in your YouTube knowledge library. Optionally filter by tag.',
    inputSchema: listLibrarySchema,
  },
  listLibraryHandler
);

// Tool 6: List video formats
server.registerTool(
  'youtube_list_formats',
  {
    title: 'List Video Formats',
    description:
      'List available download formats for a YouTube video. Returns format IDs, resolutions, codecs, and file sizes.',
    inputSchema: listFormatsSchema,
  },
  listFormatsHandler
);

// Tool 7: Download video
server.registerTool(
  'youtube_download_video',
  {
    title: 'Download Video',
    description:
      'Download a YouTube video. Use quality parameter (best, 1080p, 720p, etc.) for automatic best format selection with fallbacks. Or use formatId for specific formats from youtube_list_formats.',
    inputSchema: downloadVideoSchema,
  },
  downloadVideoHandler
);

// Connect via stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
