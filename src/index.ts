#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { fetchVideosSchema, fetchVideosHandler } from './tools/fetch-videos.js';
import { getVideoInfoSchema, getVideoInfoHandler } from './tools/get-video-info.js';
import { getTranscriptSchema, getTranscriptHandler } from './tools/get-transcript.js';
import { saveToLibrarySchema, saveToLibraryHandler } from './tools/save-to-library.js';
import { listLibrarySchema, listLibraryHandler } from './tools/list-library.js';

const server = new McpServer({
  name: 'youtube-knowledge-extractor',
  version: '1.0.0',
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

// Connect via stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
