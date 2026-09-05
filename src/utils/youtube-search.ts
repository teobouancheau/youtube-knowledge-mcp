import { parseYtDlpJsonLines, runYtDlp } from './ytdlp.js';
import { channelSearchRowSchema, searchResultSchema } from './youtube-schemas.js';
import type { ChannelInfo } from './youtube-channel.js';
import { formatDuration, watchUrl } from './youtube-url.js';

/** Keyword search for videos and channels. */

export interface SearchResult {
  id: string;
  title: string;
  duration: number;
  durationFormatted: string;
  channel: string;
  viewCount: number;
  url: string;
}

export async function searchVideos(query: string, limit = 5): Promise<SearchResult[]> {
  const stdout = await runYtDlp(['--dump-json', '--flat-playlist'], {
    label: 'search_videos',
    target: `ytsearch${limit}:${query}`,
  });

  return parseYtDlpJsonLines(stdout, searchResultSchema).map((data) => {
    return {
      id: data.id,
      title: data.title ?? 'Unknown',
      duration: data.duration ?? 0,
      durationFormatted: formatDuration(data.duration ?? 0),
      channel: data.channel ?? 'Unknown',
      viewCount: data.view_count ?? 0,
      url: data.url ?? watchUrl(data.id),
    };
  });
}

export async function searchChannels(query: string, limit = 5): Promise<ChannelInfo[]> {
  // YouTube channel filter: sp=EgIQAg%3D%3D
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%3D%3D`;

  const stdout = await runYtDlp(
    ['--dump-json', '--flat-playlist', '--playlist-items', `1-${limit}`],
    {
      label: 'search_channels',
      target: searchUrl,
    }
  );

  return parseYtDlpJsonLines(stdout, channelSearchRowSchema).map((data) => {
    return {
      name: data.channel ?? data.title ?? 'Unknown',
      channelId: data.channel_id ?? data.id ?? '',
      handle: data.uploader_id ?? '',
      subscriberCount: data.channel_follower_count ?? 0,
      channelUrl: data.channel_url ?? '',
      description: data.description ?? '',
    };
  });
}
