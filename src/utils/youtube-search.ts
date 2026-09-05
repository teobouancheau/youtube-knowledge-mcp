import { z } from 'zod';
import { isRecord, parseYtDlpJsonLines, runYtDlp } from './ytdlp.js';
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

/**
 * yt-dlp's search rows. Only `id` is required — the rest are absent often
 * enough (age-gated entries, deleted uploads still in the index) that treating
 * them as guaranteed is what produced `undefined` in rendered output.
 */
const searchResultSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  duration: z.number().optional(),
  channel: z.string().optional(),
  view_count: z.number().optional(),
  url: z.string().optional(),
});

type YtDlpSearchResult = z.infer<typeof searchResultSchema>;

function isSearchResult(value: unknown): value is YtDlpSearchResult {
  return searchResultSchema.safeParse(value).success;
}

interface YtDlpChannelSearchResult {
  id?: string;
  title?: string;
  channel?: string;
  channel_id?: string;
  channel_url?: string;
  uploader_id?: string;
  channel_follower_count?: number;
  description?: string;
}

export async function searchVideos(query: string, limit = 5): Promise<SearchResult[]> {
  const stdout = await runYtDlp(['--dump-json', '--flat-playlist'], {
    label: 'search_videos',
    target: `ytsearch${limit}:${query}`,
  });

  return parseYtDlpJsonLines(stdout, isSearchResult).map((data) => {
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

  return parseYtDlpJsonLines<YtDlpChannelSearchResult>(stdout, isRecord).map((data) => {
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
