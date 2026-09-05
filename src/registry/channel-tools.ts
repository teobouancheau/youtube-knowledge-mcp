import { defineTool, type ToolDefinition } from './types.js';
import {
  getChannelInfoSchema,
  getChannelInfoOutputSchema,
  getChannelInfoHandler,
} from '../tools/get-channel-info.js';
import {
  getPlaylistInfoSchema,
  getPlaylistInfoOutputSchema,
  getPlaylistInfoHandler,
} from '../tools/get-playlist-info.js';
import {
  searchChannelsSchema,
  searchChannelsOutputSchema,
  searchChannelsHandler,
} from '../tools/search-channels.js';

/** Channels and playlists. Remote-safe. */
export const channelTools: ToolDefinition[] = [
  defineTool({
    name: 'get_channel_info',
    mode: 'all',
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
    handler: getChannelInfoHandler,
  }),
  defineTool({
    name: 'search_channels',
    mode: 'all',
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
    handler: searchChannelsHandler,
  }),
  defineTool({
    name: 'get_playlist_info',
    mode: 'all',
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
    handler: getPlaylistInfoHandler,
  }),
];
