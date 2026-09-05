import { defineTool, type ToolDefinition } from './types.js';
import {
  fetchChannelThumbnailsSchema,
  fetchChannelThumbnailsOutputSchema,
  fetchChannelThumbnailsHandler,
} from '../tools/fetch-channel-thumbnails.js';
import {
  listChannelThumbnailsSchema,
  listChannelThumbnailsOutputSchema,
  listChannelThumbnailsHandler,
  deleteChannelThumbnailsSchema,
  deleteChannelThumbnailsOutputSchema,
  deleteChannelThumbnailsHandler,
} from '../tools/list-channel-thumbnails.js';
import {
  getThumbnailSchema,
  getThumbnailOutputSchema,
  getThumbnailHandler,
} from '../tools/get-thumbnail.js';

/**
 * Thumbnails. Looking at one is remote-safe; saving a channel's worth is local
 * only, for the same reason as the brains.
 */
export const thumbnailTools: ToolDefinition[] = [
  defineTool({
    name: 'get_thumbnail',
    mode: 'all',
    title: 'Look at a Thumbnail',
    description:
      "Return a video's thumbnail, or a channel's avatar or banner, as an image you can look at, with its real pixel size. Tries the largest image YouTube serves and falls back to smaller ones. Locally, an image saved by fetch_channel_thumbnails is served from disk.",
    inputSchema: getThumbnailSchema,
    outputSchema: getThumbnailOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: (args) => getThumbnailHandler(args, { store: false }),
    stdioHandler: (args) => getThumbnailHandler(args, { store: true }),
  }),
  defineTool({
    name: 'fetch_channel_thumbnails',
    mode: 'stdio',
    title: "Save a Channel's Thumbnails",
    description:
      "Save every video thumbnail of a channel, plus its avatar and banner, under ~/.youtube-knowledge/thumbnails. One listing per tab, then the images from YouTube's image hosts directly, largest available first; each saved image is recorded with the size actually decoded from it. Safe to interrupt and call again: images already on disk are kept, missing ones fetched. Choose tabs to include shorts and streams.",
    inputSchema: fetchChannelThumbnailsSchema,
    outputSchema: fetchChannelThumbnailsOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: fetchChannelThumbnailsHandler,
  }),
  defineTool({
    name: 'list_channel_thumbnails',
    mode: 'stdio',
    title: "List a Channel's Saved Thumbnails",
    description:
      'List the thumbnails saved for a channel: each file path, its decoded size and which image variant it is, plus the avatar and banner. Works offline from the saved manifest.',
    inputSchema: listChannelThumbnailsSchema,
    outputSchema: listChannelThumbnailsOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: listChannelThumbnailsHandler,
  }),
  defineTool({
    name: 'delete_channel_thumbnails',
    mode: 'stdio',
    title: "Delete a Channel's Saved Thumbnails",
    description:
      'Permanently delete every thumbnail saved for a channel, with its manifest. Use this to start over, for example to fetch again at a different quality.',
    inputSchema: deleteChannelThumbnailsSchema,
    outputSchema: deleteChannelThumbnailsOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: deleteChannelThumbnailsHandler,
  }),
];
