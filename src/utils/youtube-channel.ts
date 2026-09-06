import { z } from 'zod';
import { formatYouTubeDate } from './format.js';
import { TIMEOUTS, parseYtDlpJson, parseYtDlpJsonLines, runYtDlp } from './ytdlp.js';
import {
  FLAT_PRINT_TEMPLATE,
  flatEntrySchema,
  toVideoListItem,
  type ListedImage,
} from './flat-listing.js';
import { selectChannelImages } from './channel-images.js';
import { channelMetaSchema, playlistMetaSchema } from './youtube-schemas.js';
import { channelUrlFor, resolveListTarget } from './youtube-url.js';

/** Listings and metadata for channels and playlists. */

const playlistCountSchema = z.object({ playlist_count: z.number().nullish() });

export interface VideoListItem {
  id: string;
  title: string;
  duration: number;
  durationFormatted: string;
  /** Empty for a flat listing, which carries no publication date. */
  uploadDate: string;
  url: string;
  /** The largest thumbnail the listing offered. */
  thumbnailUrl?: string;
  /** Every thumbnail the listing offered, with sizes where known. */
  thumbnails?: ListedImage[];
  viewCount?: number;
  liveStatus?: string;
}

export interface ChannelInfo {
  name: string;
  channelId: string;
  handle: string;
  subscriberCount: number;
  channelUrl: string;
  description: string;
  /** The channel's uncropped avatar, when yt-dlp listed one. */
  avatarUrl?: string;
  /** The channel's uncropped banner, when yt-dlp listed one. */
  bannerUrl?: string;
}

export interface PlaylistInfo {
  id: string;
  title: string;
  channel: string;
  handle: string;
  channelUrl: string;
  videoCount: number;
  lastModified: string;
  url: string;
  description: string;
}

export async function listVideos(
  urlOrChannel: string,
  limit = 20,
  start = 1
): Promise<VideoListItem[]> {
  const stdout = await runYtDlp(
    [
      '--skip-download',
      '--flat-playlist',
      '--lazy-playlist',
      '--print',
      FLAT_PRINT_TEMPLATE,
      // `-I start:end` rather than --playlist-end so a later page can begin
      // where the previous one stopped. YouTube still walks from the top to
      // reach `start`, which is why the caller caches instead of paging deep.
      '--playlist-items',
      `${String(start)}:${String(start + limit - 1)}`,
    ],
    {
      label: 'fetch_videos',
      timeoutMs: TIMEOUTS.transcript,
      target: resolveListTarget(urlOrChannel),
    }
  );

  return parseYtDlpJsonLines(stdout, flatEntrySchema).map(toVideoListItem);
}

/**
 * How many videos a listing says it has, when it says anything.
 *
 * `playlist_count` is populated for playlists and routinely null for channel
 * tabs, so this returns undefined rather than a guess. One extra cheap call —
 * the same `--playlist-items 0` metadata read getPlaylistInfo already does.
 */
export async function playlistTotal(urlOrChannel: string): Promise<number | undefined> {
  try {
    const stdout = await runYtDlp(
      ['--dump-single-json', '--flat-playlist', '--playlist-items', '0'],
      {
        label: 'fetch_videos:count',
        timeoutMs: TIMEOUTS.metadata,
        target: resolveListTarget(urlOrChannel),
      }
    );
    const parsed = parseYtDlpJson(stdout, playlistCountSchema, 'a playlist count');
    return parsed.playlist_count ?? undefined;
  } catch {
    // A total is a nicety; failing to get one must not fail the page. Its
    // absence is already meaningful — "unknown", which is the truth here.
    return undefined;
  }
}

export async function getPlaylistInfo(playlistUrl: string): Promise<PlaylistInfo> {
  const target = resolveListTarget(playlistUrl);
  const stdout = await runYtDlp(
    ['--dump-single-json', '--flat-playlist', '--playlist-items', '0'],
    {
      label: 'get_playlist_info',
      target,
    }
  );

  const data = parseYtDlpJson(stdout, playlistMetaSchema, 'playlist metadata');
  const modDate = data.modified_date ?? '';

  return {
    id: data.id ?? '',
    title: data.title ?? 'Unknown',
    channel: data.channel ?? '',
    handle: data.uploader_id ?? '',
    channelUrl: data.channel_url ?? '',
    videoCount: data.playlist_count ?? 0,
    lastModified: formatYouTubeDate(modDate),
    url: data.webpage_url ?? playlistUrl,
    description: data.description ?? '',
  };
}

export async function getChannelInfo(channel: string): Promise<ChannelInfo> {
  const channelUrl = channelUrlFor(channel);

  const stdout = await runYtDlp(
    ['--dump-single-json', '--flat-playlist', '--playlist-items', '0'],
    {
      label: 'get_channel_info',
      target: channelUrl,
    }
  );

  const data = parseYtDlpJson(stdout, channelMetaSchema, 'channel metadata');

  return {
    name: data.channel ?? 'Unknown',
    channelId: data.channel_id ?? '',
    handle: data.uploader_id ?? '',
    subscriberCount: data.channel_follower_count ?? 0,
    channelUrl: data.channel_url ?? channelUrl,
    description: data.description ?? '',
    // The same listing carries the avatar and banner; they were discarded here
    // for two releases.
    ...selectChannelImages(data.thumbnails),
  };
}
