import { z } from 'zod';
import { listVideos } from '../utils/youtube.js';
import { toolResult } from '../utils/format.js';
import { cursorPageShape, videoSummarySchema } from '../schemas.js';
import { decodeCursor, encodeCursor } from '../utils/listing-cursor.js';
import { playlistTotal } from '../utils/youtube-channel.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const fetchVideosSchema = {
  url: z
    .string()
    .max(2048)
    .describe(
      'YouTube playlist URL, channel URL, or channel handle (e.g., https://www.youtube.com/@channel)'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(20)
    .describe('Videos per page (1-500, default 20)'),
  cursor: z
    .string()
    .max(512)
    .optional()
    .describe('Opaque token from a previous nextCursor. Omit for the first page.'),
};

export const fetchVideosOutputSchema = {
  source: z.string(),
  videos: z.array(videoSummarySchema),
  ...cursorPageShape,
};

/**
 * One page of a playlist or channel listing.
 *
 * Previously this reported `total` as the number of videos it happened to
 * return, so a caller asking for 20 of a 5,000-video channel was told it had
 * all 5,000 — `hasMore` was structurally false. Now `total` is only present
 * when YouTube states one, and its absence means unknown rather than none.
 */
export async function fetchVideosHandler({
  url,
  limit,
  cursor,
}: {
  url: string;
  limit: number;
  cursor?: string;
}): Promise<CallToolResult> {
  const position =
    cursor === undefined ? { v: 1 as const, start: 1, anchor: '' } : decodeCursor(cursor);

  const [page, total] = await Promise.all([
    listVideos(url, limit, position.start),
    playlistTotal(url),
  ]);

  // A new upload shifts every index by one, so the item we ended on can
  // reappear at the top of the next page. Dropping it is the honest fix; yt-dlp
  // cannot offer a cursor stable against edits.
  const driftDetected =
    position.anchor !== '' && page.some((video) => video.id === position.anchor);
  const videos = driftDetected ? page.filter((video) => video.id !== position.anchor) : page;

  const nextStart = position.start + page.length;
  const hasMore =
    total === undefined ? page.length === limit : nextStart <= total && page.length > 0;
  const last = videos.at(-1);

  const lines: string[] = [
    `✓ ${String(videos.length)} video${videos.length === 1 ? '' : 's'}${
      total === undefined ? '' : ` of ${String(total)}`
    }`,
    ...(total === undefined && hasMore
      ? ['YouTube states no total for this listing, so the number remaining is unknown.']
      : []),
    ...(driftDetected ? ['The listing changed between pages; a duplicate was dropped.'] : []),
    '',
  ];

  videos.forEach((video, index) => {
    lines.push(`${String(position.start + index)}. ${video.title}`);
    lines.push(`   ${video.durationFormatted} · ${video.uploadDate || 'Unknown date'}`);
    lines.push(`   ${video.url}`);
    lines.push('');
  });

  return toolResult(lines.join('\n'), {
    source: url,
    videos: videos.map((video) => ({
      id: video.id,
      title: video.title,
      durationSeconds: video.duration,
      durationFormatted: video.durationFormatted,
      url: video.url,
      uploadDate: video.uploadDate,
      ...(video.thumbnailUrl === undefined ? {} : { thumbnailUrl: video.thumbnailUrl }),
      ...(video.viewCount === undefined ? {} : { viewCount: video.viewCount }),
    })),
    count: videos.length,
    hasMore,
    ...(hasMore && last !== undefined
      ? { nextCursor: encodeCursor({ v: 1, start: nextStart, anchor: last.id }) }
      : {}),
    ...(total === undefined ? {} : { total, totalSource: 'youtube:playlist_count' as const }),
    driftDetected,
  });
}
