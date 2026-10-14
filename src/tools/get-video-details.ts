import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatCount, formatYouTubeDate, toolResult } from '../utils/format.js';
import { mostReplayed } from '../utils/most-replayed.js';
import { videoMoment, videoMomentSchema } from '../utils/moment.js';
import { readVideoStats } from '../utils/video-stats-cache.js';

/**
 * Everything yt-dlp reports about one video that get_video_info does not carry:
 * what people replay most, the licence, the music credits, the caption inventory,
 * the category and the frame size. One read, served from disk when it is fresh.
 */

const MOST_REPLAYED_COUNT = 5;

const heatSegmentSchema = z.object({
  startSeconds: z.number(),
  endSeconds: z.number(),
  value: z.number().describe('Relative replay rate, 0 to 1'),
});

const mostReplayedSchema = videoMomentSchema.extend({
  endSeconds: z.number(),
  value: z.number().describe('Relative replay rate, 0 to 1'),
});

export const getVideoDetailsSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
  heatmap: z
    .boolean()
    .default(false)
    .describe(
      'Also return the full replay heatmap, about a hundred slices. The strongest moments are always returned. Default: false'
    ),
  refresh: z
    .boolean()
    .default(false)
    .describe('Fetch from YouTube even if a fresh saved copy exists. Default: false'),
};

export const getVideoDetailsOutputSchema = {
  videoId: z.string(),
  title: z.string(),
  url: z.string(),
  channel: z.string(),
  channelId: z.string().optional(),
  channelUrl: z.string().optional(),
  channelFollowerCount: z.number().optional(),
  uploader: z.string().optional(),
  uploadDate: z.string(),
  durationSeconds: z.number(),
  durationFormatted: z.string(),
  viewCount: z.number().optional(),
  likeCount: z.number().optional(),
  commentCount: z.number().optional(),
  categories: z.array(z.string()),
  tags: z.array(z.string()),
  ageLimit: z.number().int(),
  availability: z.string().optional(),
  liveStatus: z.string().optional(),
  wasLive: z.boolean(),
  mediaType: z.string().optional(),
  license: z.string().optional(),
  language: z.string().optional(),
  playableInEmbed: z.boolean().optional(),
  releaseTimestamp: z.number().optional(),
  music: z
    .object({
      track: z.string().optional(),
      artist: z.string().optional(),
      album: z.string().optional(),
      releaseYear: z.number().optional(),
    })
    .optional(),
  video: z
    .object({
      width: z.number().optional(),
      height: z.number().optional(),
      fps: z.number().optional(),
    })
    .optional(),
  chapterCount: z.number().int(),
  captions: z.object({ manual: z.array(z.string()), automatic: z.array(z.string()) }),
  mostReplayed: z
    .array(mostReplayedSchema)
    .describe('The moments people replay most, strongest first. Empty when YouTube has no data'),
  heatmap: z.array(heatSegmentSchema).optional(),
  description: z.string(),
  descriptionChars: z.number().int(),
  thumbnailUrl: z.string().optional(),
  cached: z.boolean().describe('True when served from a saved copy rather than fetched'),
};

export interface GetVideoDetailsArgs {
  video: string;
  heatmap: boolean;
  refresh: boolean;
}

export async function getVideoDetailsHandler(args: GetVideoDetailsArgs): Promise<CallToolResult> {
  const { stats, cached } = await readVideoStats(args.video, { refresh: args.refresh });

  const peaks = mostReplayed(stats.heatmap ?? [], MOST_REPLAYED_COUNT).map((peak) => ({
    ...videoMoment(stats.id, peak.startSeconds),
    endSeconds: peak.endSeconds,
    value: peak.value,
  }));

  const counts = [
    stats.viewCount === undefined ? undefined : `${formatCount(stats.viewCount)} views`,
    stats.likeCount === undefined ? undefined : `${formatCount(stats.likeCount)} likes`,
    stats.commentCount === undefined ? undefined : `${formatCount(stats.commentCount)} comments`,
  ].filter((part) => part !== undefined);

  const lines = [
    stats.title,
    `${stats.channel}${counts.length === 0 ? '' : ` · ${counts.join(' · ')}`}`,
    `${stats.durationFormatted} · uploaded ${formatYouTubeDate(stats.uploadDate)}`,
    ...(stats.categories.length === 0 ? [] : [`Category: ${stats.categories.join(', ')}`]),
    ...(stats.license === undefined ? [] : [`License: ${stats.license}`]),
    ...(stats.language === undefined ? [] : [`Language: ${stats.language}`]),
    ...(peaks.length === 0
      ? []
      : [`Most replayed: ${peaks.map((peak) => peak.timestamp).join(', ')}`]),
    `Captions: ${stats.captions.manual.length} manual, ${stats.captions.automatic.length} automatic`,
    ...(cached ? ['', 'Served from a saved copy; pass refresh to fetch again.'] : []),
  ];

  return toolResult(lines.join('\n'), {
    videoId: stats.id,
    title: stats.title,
    url: stats.url,
    channel: stats.channel,
    channelId: stats.channelId,
    channelUrl: stats.channelUrl,
    channelFollowerCount: stats.channelFollowerCount,
    uploader: stats.uploader,
    uploadDate: stats.uploadDate,
    durationSeconds: stats.durationSeconds,
    durationFormatted: stats.durationFormatted,
    viewCount: stats.viewCount,
    likeCount: stats.likeCount,
    commentCount: stats.commentCount,
    categories: stats.categories,
    tags: stats.tags,
    ageLimit: stats.ageLimit,
    availability: stats.availability,
    liveStatus: stats.liveStatus,
    wasLive: stats.wasLive,
    mediaType: stats.mediaType,
    license: stats.license,
    language: stats.language,
    playableInEmbed: stats.playableInEmbed,
    releaseTimestamp: stats.releaseTimestamp,
    music: stats.music,
    video: stats.video,
    chapterCount: stats.chapters.length,
    captions: stats.captions,
    mostReplayed: peaks,
    ...(args.heatmap && stats.heatmap !== undefined ? { heatmap: stats.heatmap } : {}),
    description: stats.description,
    descriptionChars: stats.descriptionChars,
    thumbnailUrl: stats.thumbnailUrl,
    cached,
  });
}
