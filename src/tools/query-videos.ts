import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { pageInfo, toolResult } from '../utils/format.js';
import { paginationShape } from '../schemas.js';
import { coverageSchema, type Coverage } from '../harvest-schemas.js';
import { getStore } from '../utils/store.js';
import { countVideos, queryVideos } from '../utils/video-store.js';
import { readReceipt } from '../utils/harvest-receipts.js';

export const queryVideosSchema = {
  channel: z.string().max(64).optional().describe('Restrict to one channel id'),
  match: z.string().max(512).optional().describe('Substring match on the title'),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  minDurationSeconds: z.number().int().min(0).default(0),
  detailedOnly: z.boolean().default(false).describe('Only videos whose full metadata was read'),
  withComments: z.boolean().default(false).describe('Only videos that have harvested comments'),
  order: z.enum(['newest', 'oldest', 'views', 'comments', 'catalog']).default('newest'),
  limit: z.number().int().min(1).max(200).default(25),
  offset: z.number().int().min(0).default(0),
};

export const queryVideosOutputSchema = {
  videos: z.array(
    z.object({
      videoId: z.string(),
      channelId: z.string().optional(),
      title: z.string(),
      durationSeconds: z.number().optional(),
      uploadDate: z
        .string()
        .optional()
        .describe('Absent when only a flat listing has seen this video, which carries no date'),
      viewCount: z.number().optional(),
      tab: z.string().optional(),
      alsoInTabs: z.array(z.string()),
      storedComments: z.number().int().describe('Comments held locally, not the number it has'),
      detailed: z.boolean(),
    })
  ),
  coverage: z.array(coverageSchema).describe('The channel-catalogue receipts these rows came from'),
  ...paginationShape,
};

/** The column is a JSON array written by SQLite's json_insert. */
function parseTabs(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return z.array(z.string()).catch([]).parse(parsed);
}

/** Searches the catalogued videos. Local only; never contacts YouTube. */
export async function queryVideosHandler(input: {
  channel?: string;
  match?: string;
  since?: string;
  until?: string;
  minDurationSeconds: number;
  detailedOnly: boolean;
  withComments: boolean;
  order: 'newest' | 'oldest' | 'views' | 'comments' | 'catalog';
  limit: number;
  offset: number;
}): Promise<CallToolResult> {
  const store = await getStore();
  const query = {
    ...(input.channel === undefined ? {} : { channelId: input.channel }),
    ...(input.match === undefined ? {} : { match: input.match }),
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.until === undefined ? {} : { until: input.until }),
    minDurationSeconds: input.minDurationSeconds,
    detailedOnly: input.detailedOnly,
    withComments: input.withComments,
    order: input.order,
    limit: input.limit,
    offset: input.offset,
  };

  const rows = queryVideos(store, query);
  const total = countVideos(store, query);

  const channelIds = [...new Set(rows.map((row) => row.channel_id).filter((id) => id !== null))];
  const coverage = channelIds
    .map((channelId) => readReceipt(store, 'channel-catalog', channelId))
    .filter((receipt): receipt is Coverage => receipt !== undefined);

  const incomplete = coverage.filter((receipt) => !receipt.complete).length;
  const lines = [
    `${String(rows.length)} of ${String(total)} videos in the store.`,
    ...(incomplete > 0
      ? ['At least one channel here is only partly catalogued, so this is not its full video list.']
      : []),
    '',
    ...rows.map(
      (row) =>
        `${row.upload_date ?? '(no date)'} ${row.title} — ${String(row.stored_comments)} comments held`
    ),
  ];

  return toolResult(lines.join('\n'), {
    videos: rows.map((row) => ({
      videoId: row.video_id,
      ...(row.channel_id === null ? {} : { channelId: row.channel_id }),
      title: row.title,
      ...(row.duration_s === null ? {} : { durationSeconds: row.duration_s }),
      ...(row.upload_date === null ? {} : { uploadDate: row.upload_date }),
      ...(row.view_count === null ? {} : { viewCount: row.view_count }),
      ...(row.tab === null ? {} : { tab: row.tab }),
      alsoInTabs: parseTabs(row.also_in_tabs),
      storedComments: row.stored_comments,
      detailed: row.detail_at !== null,
    })),
    coverage,
    ...pageInfo({ total, count: rows.length, offset: input.offset }),
  });
}
