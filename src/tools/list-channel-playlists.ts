import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolResult } from '../utils/format.js';
import { MAX_CHANNEL_PLAYLISTS, listChannelPlaylists } from '../utils/channel-playlists.js';

const DEFAULT_LIMIT = 50;

export const listChannelPlaylistsSchema = {
  channel: z
    .string()
    .max(256)
    .describe('YouTube channel URL, handle (e.g., @Fireship), channel id or channel name'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_CHANNEL_PLAYLISTS)
    .default(DEFAULT_LIMIT)
    .describe(
      `How many playlists to list, up to ${MAX_CHANNEL_PLAYLISTS}. Default: ${DEFAULT_LIMIT}`
    ),
};

export const listChannelPlaylistsOutputSchema = {
  channelId: z.string(),
  channelName: z.string(),
  count: z.number().int(),
  mayHaveMore: z.boolean().describe('True when the limit was reached, so there may be more'),
  playlists: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })),
};

export async function listChannelPlaylistsHandler(args: {
  channel: string;
  limit: number;
}): Promise<CallToolResult> {
  const { channelId, channelName, playlists, mayHaveMore } = await listChannelPlaylists(
    args.channel,
    args.limit
  );

  const structured = { channelId, channelName, count: playlists.length, mayHaveMore, playlists };

  if (playlists.length === 0) {
    return toolResult(`${channelName} has no public playlists.`, structured);
  }

  const lines = [
    `${channelName}: ${playlists.length} playlists`,
    '',
    ...playlists.flatMap((playlist, index) => [
      `${index + 1}. ${playlist.title}`,
      `   ${playlist.url}`,
    ]),
    ...(mayHaveMore ? ['', 'Raise limit to list more.'] : []),
    '',
    'Pass a playlist URL to fetch_videos or digest_playlist.',
  ];

  return toolResult(lines.join('\n'), structured);
}
