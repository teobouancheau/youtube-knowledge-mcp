import { formatYouTubeDate } from './format.js';
import { TIMEOUTS, isRecord, parseYtDlpJson, runYtDlp } from './ytdlp.js';
import { formatDuration, watchUrl } from './youtube-url.js';

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

interface YtDlpChannelMeta {
  channel?: string;
  channel_id?: string;
  channel_url?: string;
  uploader_id?: string;
  channel_follower_count?: number;
  description?: string;
}

interface YtDlpPlaylistMeta {
  id?: string;
  title?: string;
  channel?: string;
  channel_url?: string;
  uploader_id?: string;
  playlist_count?: number;
  modified_date?: string;
  webpage_url?: string;
  description?: string;
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
      urlOrChannel,
    ],
    { label: 'fetch_videos', timeoutMs: TIMEOUTS.transcript }
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
  const stdout = await runYtDlp(
    ['--dump-single-json', '--flat-playlist', '--playlist-items', '0', playlistUrl],
    { label: 'get_playlist_info' }
  );

  const data = parseYtDlpJson<YtDlpPlaylistMeta>(stdout, isRecord, 'playlist metadata');
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
  const channelUrl = channel.startsWith('http')
    ? channel
    : `https://www.youtube.com/${channel.startsWith('@') ? channel : `@${channel}`}`;

  const stdout = await runYtDlp(
    ['--dump-single-json', '--flat-playlist', '--playlist-items', '0', channelUrl],
    { label: 'get_channel_info' }
  );

  const data = parseYtDlpJson<YtDlpChannelMeta>(stdout, isRecord, 'channel metadata');

  return {
    name: data.channel ?? 'Unknown',
    channelId: data.channel_id ?? '',
    handle: data.uploader_id ?? '',
    subscriberCount: data.channel_follower_count ?? 0,
    channelUrl: data.channel_url ?? channelUrl,
    description: data.description ?? '',
  };
}
