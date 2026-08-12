#!/usr/bin/env node

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { searchTranscriptSchema, searchTranscriptHandler } from './tools/search-transcript.js';
import {
  getTranscriptsSchema,
  getTranscriptsHandler,
  digestPlaylistSchema,
  digestPlaylistHandler,
} from './tools/batch.js';
import {
  extractClipSchema,
  extractClipHandler,
  extractAudioClipSchema,
  extractAudioClipHandler,
  extractClipsSchema,
  extractClipsHandler,
  extractFrameSchema,
  extractFrameHandler,
  exportSubtitlesSchema,
  exportSubtitlesHandler,
} from './tools/clips.js';
import {
  getLibraryItemSchema,
  getLibraryItemHandler,
  searchLibrarySchema,
  searchLibraryHandler,
  deleteLibraryItemSchema,
  deleteLibraryItemHandler,
  updateLibraryTagsSchema,
  updateLibraryTagsHandler,
  rebuildLibraryIndexSchema,
  rebuildLibraryIndexHandler,
} from './tools/library.js';
import { runWithRequestContext } from './utils/context.js';
import { toToolError } from './utils/errors.js';
import { formatPreflightReport, runPreflight } from './utils/preflight.js';
import { startHttp } from './http.js';

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
    'search_transcript',
    {
      title: 'Search Inside a Transcript',
      description:
        'Find a phrase or pattern inside a video transcript and return each match with its timestamp and a link that opens the video at that moment. Use this instead of reading a whole transcript when you need to locate or cite a specific moment.',
      inputSchema: searchTranscriptSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(searchTranscriptHandler)
  );

  server.registerTool(
    'get_transcripts',
    {
      title: 'Get Transcripts for Several Videos',
      description:
        'Fetch transcripts for up to 25 videos in one call, each capped so the batch cannot flood the context. Videos that have no captions are reported individually rather than failing the whole call.',
      inputSchema: getTranscriptsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(getTranscriptsHandler)
  );

  server.registerTool(
    'digest_playlist',
    {
      title: 'Digest a Playlist or Channel',
      description:
        'Summarize a playlist or channel in one call: per-video metadata, chapter markers, and optionally transcript word counts. Use this to survey a body of content before deciding what to read in full.',
      inputSchema: digestPlaylistSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(digestPlaylistHandler)
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
      'get_library_item',
      {
        title: 'Read a Saved Library Item',
        description:
          'Read back a summary or skill note previously saved with save_to_library. Returns the markdown content plus the saved metadata.',
        inputSchema: getLibraryItemSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(getLibraryItemHandler)
    );

    server.registerTool(
      'search_library',
      {
        title: 'Search the Knowledge Library',
        description:
          'Full-text search across every saved summary and skill note, ranked by relevance. Returns matching excerpts with the video IDs needed to read the full note.',
        inputSchema: searchLibrarySchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(searchLibraryHandler)
    );

    server.registerTool(
      'update_library_tags',
      {
        title: 'Update Library Tags',
        description:
          'Add, remove or replace the tags on a saved library item. Tags are how list_library filters, so this is the way to reorganize a growing library.',
        inputSchema: updateLibraryTagsSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(updateLibraryTagsHandler)
    );

    server.registerTool(
      'delete_library_item',
      {
        title: 'Delete a Library Item',
        description:
          'Permanently delete a saved summary or skill note, or the entire library entry for a video. This removes files from disk and cannot be undone.',
        inputSchema: deleteLibraryItemSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(deleteLibraryItemHandler)
    );

    server.registerTool(
      'rebuild_library_index',
      {
        title: 'Rebuild the Library Search Index',
        description:
          'Rebuild the full-text search index from the notes on disk. Use this if search_library results look stale or incomplete, for example after editing files by hand.',
        inputSchema: rebuildLibraryIndexSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(rebuildLibraryIndexHandler)
    );

    server.registerTool(
      'extract_clip',
      {
        title: 'Extract a Video Clip',
        description:
          'Cut a time range out of a YouTube video without downloading the whole thing. Give start and end, or a chapter name. Pair with search_transcript to find the moment first. Requires ffmpeg.',
        inputSchema: extractClipSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      guarded(extractClipHandler)
    );

    server.registerTool(
      'extract_audio_clip',
      {
        title: 'Extract an Audio Clip',
        description:
          'Cut a time range out of a video as audio only, in an editor-friendly format (mp3, m4a, wav, flac, opus). Use for podcast pulls and voice-over sourcing. Requires ffmpeg.',
        inputSchema: extractAudioClipSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      guarded(extractAudioClipHandler)
    );

    server.registerTool(
      'extract_clips',
      {
        title: 'Extract Several Clips',
        description:
          'Cut several time ranges out of one video in a single call. A range that fails is reported individually rather than losing the clips that succeeded. Requires ffmpeg.',
        inputSchema: extractClipsSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      guarded(extractClipsHandler)
    );

    server.registerTool(
      'extract_frame',
      {
        title: 'Capture a Frame',
        description:
          'Capture a single still image from a video at a given timestamp, without downloading the file. Use for thumbnails and reference frames. Requires ffmpeg.',
        inputSchema: extractFrameSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      guarded(extractFrameHandler)
    );

    server.registerTool(
      'export_subtitles',
      {
        title: 'Export Subtitles',
        description:
          'Write a video transcript to disk as SRT, WebVTT or plain text, ready to import into a video editor such as Premiere, Resolve or CapCut.',
        inputSchema: exportSubtitlesSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      guarded(exportSubtitlesHandler)
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
    startHttp(createServer);
  } else {
    await startStdio();
  }
}

main().catch((error: unknown) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
