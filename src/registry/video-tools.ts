import { defineTool, type ToolDefinition } from './types.js';
import {
  listFormatsSchema,
  listFormatsOutputSchema,
  listFormatsHandler,
} from '../tools/download-video.js';
import {
  fetchVideosSchema,
  fetchVideosOutputSchema,
  fetchVideosHandler,
} from '../tools/fetch-videos.js';
import {
  getChaptersSchema,
  getChaptersOutputSchema,
  getChaptersHandler,
} from '../tools/get-chapters.js';
import {
  getCommentsSchema,
  getCommentsOutputSchema,
  getCommentsHandler,
} from '../tools/get-comments.js';
import {
  getVideoInfoSchema,
  getVideoInfoOutputSchema,
  getVideoInfoHandler,
} from '../tools/get-video-info.js';
import {
  searchVideosSchema,
  searchVideosOutputSchema,
  searchVideosHandler,
} from '../tools/search-videos.js';

/** Finding videos and reading what YouTube knows about one. Remote-safe: nothing here touches the filesystem. */
export const videoTools: ToolDefinition[] = [
  defineTool({
    name: 'search_videos',
    mode: 'all',
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
    handler: searchVideosHandler,
  }),
  defineTool({
    name: 'fetch_videos',
    mode: 'all',
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
    handler: fetchVideosHandler,
  }),
  defineTool({
    name: 'get_video_info',
    mode: 'all',
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
    handler: getVideoInfoHandler,
  }),
  defineTool({
    name: 'get_chapters',
    mode: 'all',
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
    handler: getChaptersHandler,
  }),
  defineTool({
    name: 'get_comments',
    mode: 'all',
    title: 'Get YouTube Video Comments',
    description:
      "Read a sample of a video's comments, with replies when includeReplies is set. Returns a completeness receipt saying how many of the video's comments this is — the real total comes from a separate metadata read, because a comment fetch reports only what it extracted. This is a sample, not a page: YouTube exposes no cursor for a live comment read.",
    inputSchema: getCommentsSchema,
    outputSchema: getCommentsOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: getCommentsHandler,
  }),
  defineTool({
    name: 'list_formats',
    mode: 'all',
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
    handler: listFormatsHandler,
  }),
];
