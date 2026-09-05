import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  fetchVideosSchema,
  fetchVideosOutputSchema,
  fetchVideosHandler,
} from './tools/fetch-videos.js';
import {
  getVideoInfoSchema,
  getVideoInfoOutputSchema,
  getVideoInfoHandler,
} from './tools/get-video-info.js';
import {
  getTranscriptSchema,
  getTranscriptOutputSchema,
  getTranscriptHandler,
} from './tools/get-transcript.js';
import {
  searchVideosSchema,
  searchVideosOutputSchema,
  searchVideosHandler,
} from './tools/search-videos.js';
import {
  getChaptersSchema,
  getChaptersOutputSchema,
  getChaptersHandler,
} from './tools/get-chapters.js';
import {
  getCommentsSchema,
  getCommentsOutputSchema,
  getCommentsHandler,
} from './tools/get-comments.js';
import {
  getChannelInfoSchema,
  getChannelInfoOutputSchema,
  getChannelInfoHandler,
} from './tools/get-channel-info.js';
import {
  searchChannelsSchema,
  searchChannelsOutputSchema,
  searchChannelsHandler,
} from './tools/search-channels.js';
import {
  getPlaylistInfoSchema,
  getPlaylistInfoOutputSchema,
  getPlaylistInfoHandler,
} from './tools/get-playlist-info.js';
import {
  saveToLibrarySchema,
  saveToLibraryOutputSchema,
  saveToLibraryHandler,
} from './tools/save-to-library.js';
import {
  listLibrarySchema,
  listLibraryOutputSchema,
  listLibraryHandler,
} from './tools/list-library.js';
import {
  listFormatsSchema,
  listFormatsOutputSchema,
  listFormatsHandler,
  downloadVideoSchema,
  downloadVideoOutputSchema,
  downloadVideoHandler,
} from './tools/download-video.js';
import {
  checkHealthSchema,
  checkHealthOutputSchema,
  checkHealthHandler,
} from './tools/check-health.js';
import {
  searchTranscriptSchema,
  searchTranscriptOutputSchema,
  searchTranscriptHandler,
} from './tools/search-transcript.js';
import {
  getTranscriptsSchema,
  getTranscriptsOutputSchema,
  getTranscriptsHandler,
  digestPlaylistSchema,
  digestPlaylistOutputSchema,
  digestPlaylistHandler,
} from './tools/batch.js';
import {
  extractClipSchema,
  extractClipOutputSchema,
  extractClipHandler,
  extractAudioClipSchema,
  extractAudioClipOutputSchema,
  extractAudioClipHandler,
  extractClipsSchema,
  extractClipsOutputSchema,
  extractClipsHandler,
} from './tools/clips.js';
import {
  extractFrameSchema,
  extractFrameOutputSchema,
  extractFrameHandler,
  exportSubtitlesSchema,
  exportSubtitlesOutputSchema,
  exportSubtitlesHandler,
} from './tools/frames-subtitles.js';
import {
  getLibraryItemSchema,
  getLibraryItemOutputSchema,
  getLibraryItemHandler,
  searchLibrarySchema,
  searchLibraryOutputSchema,
  searchLibraryHandler,
  deleteLibraryItemSchema,
  deleteLibraryItemOutputSchema,
  deleteLibraryItemHandler,
  updateLibraryTagsSchema,
  updateLibraryTagsOutputSchema,
  updateLibraryTagsHandler,
  rebuildLibraryIndexSchema,
  rebuildLibraryIndexOutputSchema,
  rebuildLibraryIndexHandler,
} from './tools/library.js';
import {
  buildBrainHandler,
  buildBrainOutputSchema,
  buildBrainSchema,
} from './tools/build-brain.js';
import { askBrainHandler, askBrainOutputSchema, askBrainSchema } from './tools/ask-brain.js';
import {
  getBrainInfoHandler,
  getBrainInfoOutputSchema,
  getBrainInfoSchema,
  listBrainsHandler,
  listBrainsOutputSchema,
  listBrainsSchema,
} from './tools/brain-info.js';
import {
  deleteBrainHandler,
  deleteBrainOutputSchema,
  deleteBrainSchema,
  saveBrainProfileHandler,
  saveBrainProfileOutputSchema,
  saveBrainProfileSchema,
} from './tools/manage-brain.js';
import { runWithRequestContext } from './utils/context.js';
import { toToolError } from './utils/errors.js';
import { formatPreflightReport, runPreflight } from './utils/preflight.js';
import { startHttp } from './http.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The version is advertised in the MCP initialize response, so a package.json
// that has lost it should fail loudly at startup rather than telling every
// client the server is version `undefined`.
const pkg = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')));

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
/**
 * The parts of the SDK's `RequestHandlerExtra` this server uses.
 *
 * `sendNotification` is described with `z.custom` because a function is not
 * something Zod can take apart structurally — the predicate is a real runtime
 * check, and it is what lets the property be called without asserting a type
 * over it.
 */
const requestExtraSchema = z.object({
  signal: z.instanceof(AbortSignal).optional(),
  sendNotification: z
    .custom<(notification: unknown) => Promise<void>>((value) => typeof value === 'function')
    .optional(),
  _meta: z.object({ progressToken: z.union([z.string(), z.number()]).optional() }).optional(),
});

function guarded<A extends unknown[]>(
  handler: (...args: A) => Promise<CallToolResult>
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A): Promise<CallToolResult> => {
    // Handlers declare only their own parameters; the SDK appends
    // RequestHandlerExtra to every call, so it is whatever arrived last.
    const parsed = requestExtraSchema.safeParse(args[args.length - 1]);
    const context = parsed.success ? parsed.data : undefined;
    const signal = context?.signal;

    return runWithRequestContext(
      {
        signal,
        // Progress is only meaningful when the client asked for it by sending a
        // token; without one the notification would be dropped anyway.
        reportProgress:
          context?.sendNotification && context._meta?.progressToken !== undefined
            ? (progress, total, message) => {
                void context.sendNotification?.({
                  method: 'notifications/progress',
                  params: {
                    progressToken: context._meta?.progressToken,
                    progress,
                    ...(total === undefined ? {} : { total }),
                    ...(message === undefined ? {} : { message }),
                  },
                });
              }
            : undefined,
        log: context?.sendNotification
          ? (level, message) => {
              void context.sendNotification?.({
                method: 'notifications/message',
                params: { level, logger: 'youtube-knowledge-mcp', data: message },
              });
            }
          : undefined,
      },
      async () => {
        try {
          return await handler(...args);
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  };
}

/**
 * Build a fully configured server.
 *
 * Exported so the test suite can drive it over an in-memory transport as a real
 * MCP client, rather than only testing handlers in isolation.
 */
export function createServer(mode: 'stdio' | 'http' = 'stdio'): McpServer {
  const server = new McpServer(
    { name: 'youtube-knowledge-mcp', version: pkg.version },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } }
  );

  // -- Remote-safe tools (registered in all modes) --

  server.registerTool(
    'search_videos',
    {
      title: 'Search YouTube Videos',
      description:
        'Search YouTube for videos by keyword or phrase. Returns video IDs, titles, durations, channels, view counts, and URLs. Results sorted by relevance.',
      inputSchema: searchVideosSchema,
      outputSchema: searchVideosOutputSchema,
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
      outputSchema: fetchVideosOutputSchema,
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
      outputSchema: getVideoInfoOutputSchema,
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
      outputSchema: getTranscriptOutputSchema,
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
      outputSchema: getChaptersOutputSchema,
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
      outputSchema: getCommentsOutputSchema,
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
      outputSchema: getChannelInfoOutputSchema,
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
      outputSchema: searchChannelsOutputSchema,
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
      outputSchema: getPlaylistInfoOutputSchema,
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
      outputSchema: listFormatsOutputSchema,
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
      outputSchema: searchTranscriptOutputSchema,
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
      outputSchema: getTranscriptsOutputSchema,
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
      outputSchema: digestPlaylistOutputSchema,
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
    'check_health',
    {
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
    },
    guarded(checkHealthHandler)
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
        outputSchema: saveToLibraryOutputSchema,
        annotations: {
          readOnlyHint: false,
          // Overwrites an existing note of the same type in place, which is a
          // destructive update: the previous content is not recoverable.
          destructiveHint: true,
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
        outputSchema: listLibraryOutputSchema,
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
        outputSchema: getLibraryItemOutputSchema,
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
        outputSchema: searchLibraryOutputSchema,
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
          'Add, remove or replace the tags on a saved library item. Tags are how list_library filters, so this is the way to reorganize a growing library. The replace parameter discards all existing tags.',
        inputSchema: updateLibraryTagsSchema,
        outputSchema: updateLibraryTagsOutputSchema,
        annotations: {
          readOnlyHint: false,
          // The replace parameter discards every existing tag.
          destructiveHint: true,
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
        outputSchema: deleteLibraryItemOutputSchema,
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
        outputSchema: rebuildLibraryIndexOutputSchema,
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
        outputSchema: extractClipOutputSchema,
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
        outputSchema: extractAudioClipOutputSchema,
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
        outputSchema: extractClipsOutputSchema,
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
        outputSchema: extractFrameOutputSchema,
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
        outputSchema: exportSubtitlesOutputSchema,
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
        outputSchema: downloadVideoOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          // Writes to a deterministic path and overwrites, exactly like the
          // extract_* tools; repeating the call leaves the same state.
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      guarded(downloadVideoHandler)
    );

    // -- Channel brains --
    //
    // Local like the library, and for the same reason: a brain is tens of
    // megabytes of one user's reading, and in HTTP mode any client could fill
    // the server's disk by naming a channel.

    server.registerTool(
      'build_brain',
      {
        title: 'Build a Channel Brain',
        description:
          "Read a channel's videos into a searchable corpus of timestamped passages, so you can later ask what its creator has said about anything. Long-running: several hundred videos is several hundred fetches. Safe to interrupt and call again — it continues where it stopped, and on a finished brain it picks up new uploads. The since and minDurationSeconds filters describe the brain, not just the call: narrowing one discards the passages of the videos it excludes, and widening it reads them again. Ask it questions with ask_brain.",
        inputSchema: buildBrainSchema,
        outputSchema: buildBrainOutputSchema,
        annotations: {
          readOnlyHint: false,
          // A plain build only adds, but narrowing a filter drops the passages
          // of videos it excludes, and a client should be able to ask first.
          destructiveHint: true,
          // Re-running converges on the same brain rather than duplicating
          // anything: that is the same code path as resuming.
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      guarded(buildBrainHandler)
    );

    server.registerTool(
      'ask_brain',
      {
        title: 'Ask a Channel Brain',
        description:
          'Search everything a creator has said, across every video in their brain. Returns the passages that match, each with the timestamp and a link that opens the video at that moment, so every claim can be checked. Matches the words as spoken, so phrase the query the way the creator would say it. Requires build_brain first.',
        inputSchema: askBrainSchema,
        outputSchema: askBrainOutputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(askBrainHandler)
    );

    server.registerTool(
      'list_brains',
      {
        title: 'List Channel Brains',
        description:
          'List every channel brain built locally, with how much of each channel is indexed and whether a written profile exists.',
        inputSchema: listBrainsSchema,
        outputSchema: listBrainsOutputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(listBrainsHandler)
    );

    server.registerTool(
      'get_brain_info',
      {
        title: 'Get Channel Brain Details',
        description:
          "What a brain actually covers: how many videos were read, how many had no captions, how many are still outstanding, the channel's upload rhythm and speaking rate, and the phrases it repeats across videos. Read this before trusting an answer built from ask_brain.",
        inputSchema: getBrainInfoSchema,
        outputSchema: getBrainInfoOutputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(getBrainInfoHandler)
    );

    server.registerTool(
      'save_brain_profile',
      {
        title: 'Save a Channel Brain Profile',
        description:
          'Store a written account of a creator alongside their brain — voice, recurring arguments, how their thinking has changed. Write it from passages returned by ask_brain and cite them, because this server cannot check a claim it was handed. Overwrites any existing profile for that channel.',
        inputSchema: saveBrainProfileSchema,
        outputSchema: saveBrainProfileOutputSchema,
        annotations: {
          readOnlyHint: false,
          // Replaces the previous profile in place; the old text is not recoverable.
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(saveBrainProfileHandler)
    );

    server.registerTool(
      'delete_brain',
      {
        title: 'Delete a Channel Brain',
        description:
          'Permanently delete a channel brain: its passages, its manifest and its profile. The transcripts it was built from stay cached, so rebuilding is much faster than the first build was.',
        inputSchema: deleteBrainSchema,
        outputSchema: deleteBrainOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      guarded(deleteBrainHandler)
    );
  }

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
  await announcePreflight();

  if (mode === 'http') {
    startHttp(createServer);
  } else {
    await startStdio();
  }
}

// Nothing starts on import: the test suite imports this module, and the only
// caller of `main()` is `cli.ts`, the file the `bin` entry points at.
