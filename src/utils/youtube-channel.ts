import { formatYouTubeDate } from './format.js';
import { TIMEOUTS, parseYtDlpJson, runYtDlp } from './ytdlp.js';
import { channelMetaSchema, playlistMetaSchema } from './youtube-schemas.js';
import { channelUrlFor, formatDuration, resolveListTarget, watchUrl } from './youtube-url.js';

/** Listings and metadata for channels and playlists. */

export interface VideoListItem {
  id: string;
  title: string;
  duration: number;
  durationFormatted: string;
  uploadDate: string;
  url: string;
}

export interface ChannelInfo {
  name: string;
  channelId: string;
  handle: string;
  subscriberCount: number;
  channelUrl: string;
  description: string;
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

export async function listVideos(urlOrChannel: string, limit = 20): Promise<VideoListItem[]> {
  const stdout = await runYtDlp(
    [
      '--skip-download',
      '--flat-playlist',
      '--print',
      '%(id)s|||%(title)s|||%(duration)s|||%(upload_date)s',
      '--playlist-end',
      limit.toString(),
    ],
    {
      label: 'fetch_videos',
      timeoutMs: TIMEOUTS.transcript,
      target: resolveListTarget(urlOrChannel),
    }
  );

  const lines = stdout.trim().split('\n').filter(Boolean);

  return lines.map((line) => {
    const parts = line.split('|||');
    const field = (index: number): string => parts[index] ?? '';

    const id = field(0);
    const duration = parseInt(field(2), 10) || 0;

    return {
      id,
      title: field(1) || 'Unknown title',
      duration,
      durationFormatted: formatDuration(duration),
      uploadDate: formatYouTubeDate(field(3)),
      url: watchUrl(id),
    };
  });
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
  };
}
