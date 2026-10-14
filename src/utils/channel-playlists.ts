import { z } from 'zod';
import { TIMEOUTS, parseYtDlpJsonLines, runYtDlp } from './ytdlp.js';
import { isAbsentTab } from './harvest-catalog.js';
import { getChannelInfo } from './youtube-channel.js';
import { resolveListTarget } from './youtube-url.js';

/**
 * The playlists a channel has published, from its playlists tab.
 *
 * Verified against yt-dlp 2026.07.04 on a real channel: a flat entry carries the
 * playlist's id, title and url, and no video count, so none is promised here.
 */

export const MAX_CHANNEL_PLAYLISTS = 200;

const PLAYLIST_PRINT_TEMPLATE = '%(.{id,title,url})j';

const playlistEntrySchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  url: z.string().nullish(),
});

export interface ChannelPlaylist {
  id: string;
  title: string;
  url: string;
}

export interface ChannelPlaylists {
  channelId: string;
  channelName: string;
  playlists: ChannelPlaylist[];
  /** True when the limit was reached, so the channel may have more. */
  mayHaveMore: boolean;
}

export async function listChannelPlaylists(
  channel: string,
  limit: number
): Promise<ChannelPlaylists> {
  const info = await getChannelInfo(channel);

  let stdout: string;
  try {
    stdout = await runYtDlp(
      [
        '--skip-download',
        '--flat-playlist',
        '--lazy-playlist',
        '--print',
        PLAYLIST_PRINT_TEMPLATE,
        '--playlist-items',
        `1:${String(limit)}`,
      ],
      {
        label: 'list_channel_playlists',
        timeoutMs: TIMEOUTS.transcript,
        target: resolveListTarget(`${info.channelUrl}/playlists`),
      }
    );
  } catch (error) {
    // A channel without a playlists tab has no playlists: an answer, not a failure.
    if (isAbsentTab(error)) stdout = '';
    else throw error;
  }

  const playlists = parseYtDlpJsonLines(stdout, playlistEntrySchema).map((entry) => ({
    id: entry.id,
    title: entry.title ?? 'Untitled',
    url: entry.url ?? `https://www.youtube.com/playlist?list=${entry.id}`,
  }));

  return {
    channelId: info.channelId,
    channelName: info.name,
    playlists,
    mayHaveMore: playlists.length >= limit,
  };
}
