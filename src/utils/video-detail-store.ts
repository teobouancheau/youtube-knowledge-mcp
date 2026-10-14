import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { queryRow, queryRows } from './store-rows.js';
import { MAX_DETAIL_JSON_BYTES, stripForStorage, type videoStatsRowSchema } from './video-stats.js';

/**
 * Keeping what a full read of a video said, on the catalogue row that names it.
 *
 * A flat listing knows a title, a duration and a view count. Reading the video itself
 * adds what the listing cannot: the record, the replay heatmap, and the counts YouTube
 * states, which a comment receipt is measured against. Until now those columns
 * existed and nothing wrote them, so a video was never "detailed".
 */

type StatsRow = z.infer<typeof videoStatsRowSchema>;

/** Parts of a record, bulkiest first, given up before a record is cut down to its identity. */
const DROPPED_WHEN_TOO_LARGE = ['description', 'chapters', 'tags', 'categories'] as const;

const UPDATE = `
UPDATE video SET
  duration_s    = COALESCE(?, duration_s),
  upload_date   = COALESCE(?, upload_date),
  view_count    = COALESCE(?, view_count),
  like_count    = COALESCE(?, like_count),
  comment_count = COALESCE(?, comment_count),
  live_status   = COALESCE(?, live_status),
  availability  = COALESCE(?, availability),
  thumbnail_url = COALESCE(?, thumbnail_url),
  detail_at     = ?,
  detail_json   = ?,
  heatmap_json  = ?
WHERE video_id = ?`;

/** The record as JSON that fits the cap, losing the least that is needed to fit. */
function recordJson(row: StatsRow): string {
  const record = stripForStorage({ ...row });
  let json = JSON.stringify(record);
  if (Buffer.byteLength(json) <= MAX_DETAIL_JSON_BYTES) return json;

  const trimmed: Record<string, unknown> = { ...record, detail_truncated: true };
  for (const key of DROPPED_WHEN_TOO_LARGE) {
    Reflect.deleteProperty(trimmed, key);
    json = JSON.stringify(trimmed);
    if (Buffer.byteLength(json) <= MAX_DETAIL_JSON_BYTES) return json;
  }
  return JSON.stringify({ id: row.id, title: row.title ?? null, detail_truncated: true });
}

/** Writes a read onto the video's catalogue row. A video the catalogue has not seen is left alone. */
export function saveVideoDetail(database: DatabaseSync, row: StatsRow, now: number): void {
  const heatmap = row.heatmap ?? [];

  database
    .prepare(UPDATE)
    .run(
      row.duration === null || row.duration === undefined ? null : Math.round(row.duration),
      row.upload_date ?? null,
      row.view_count ?? null,
      row.like_count ?? null,
      row.comment_count ?? null,
      row.live_status ?? null,
      row.availability ?? null,
      row.thumbnail ?? null,
      now,
      recordJson(row),
      heatmap.length === 0 ? null : JSON.stringify(heatmap),
      row.id
    );
}

/**
 * What a video's `availability` is set to when it could not be read, by the error it
 * gave. These videos are skipped from then on: left in the queue they would be tried
 * first, fail first, and starve every video behind them on every run.
 */
export const UNREADABLE_AVAILABILITY = {
  PRIVATE: 'private',
  MEMBERS_ONLY: 'subscriber_only',
  PREMIUM_ONLY: 'premium_only',
  NOT_FOUND: 'unavailable',
  AGE_GATED: 'needs_auth',
} as const;

/**
 * For a failure that is not one of those: a live stream not over, a timeout, an error
 * yt-dlp could not explain. It may well pass later, so it is told apart from the above,
 * but it is skipped all the same, or a video that keeps failing would hold the queue.
 */
export const READ_FAILED_AVAILABILITY = 'read_failed';

export type UnreadableAvailability =
  | (typeof UNREADABLE_AVAILABILITY)[keyof typeof UNREADABLE_AVAILABILITY]
  | typeof READ_FAILED_AVAILABILITY;

const UNREADABLE_VALUES: UnreadableAvailability[] = [
  ...Object.values(UNREADABLE_AVAILABILITY),
  READ_FAILED_AVAILABILITY,
];
const NOT_UNREADABLE = `(availability IS NULL OR availability NOT IN (${UNREADABLE_VALUES.map(() => '?').join(', ')}))`;

/** Remembers that this video cannot be read, without pretending it was. */
export function markUnreadable(
  database: DatabaseSync,
  videoId: string,
  availability: UnreadableAvailability
): void {
  database
    .prepare('UPDATE video SET availability = ? WHERE video_id = ?')
    .run(availability, videoId);
}

/** The channel's catalogued videos not yet read, in catalogue order. */
export function pendingVideoIds(
  database: DatabaseSync,
  channelId: string,
  limit: number,
  options: { includeUnreadable?: boolean } = {}
): string[] {
  const unreadable = options.includeUnreadable === true ? '' : ` AND ${NOT_UNREADABLE}`;
  const params = options.includeUnreadable === true ? [] : UNREADABLE_VALUES;

  return queryRows(
    database.prepare(
      `SELECT video_id FROM video
       WHERE channel_id = ? AND detail_at IS NULL${unreadable}
       ORDER BY catalog_rank ASC NULLS LAST, video_id
       LIMIT ?`
    ),
    z.object({ video_id: z.string() }),
    channelId,
    ...params,
    limit
  ).map((row) => row.video_id);
}

/** How many of the channel's videos are known to be unreadable, and so never queued. */
export function unreadableCount(database: DatabaseSync, channelId: string): number {
  const row = queryRow(
    database.prepare(
      `SELECT COUNT(*) AS n FROM video WHERE channel_id = ? AND detail_at IS NULL AND NOT ${NOT_UNREADABLE}`
    ),
    z.object({ n: z.number() }),
    channelId,
    ...UNREADABLE_VALUES
  );
  return row?.n ?? 0;
}

export function catalogCounts(
  database: DatabaseSync,
  channelId: string
): { videos: number; detailed: number } {
  const row = queryRow(
    database.prepare(
      'SELECT COUNT(*) AS videos, COUNT(detail_at) AS detailed FROM video WHERE channel_id = ?'
    ),
    z.object({ videos: z.number(), detailed: z.number() }),
    channelId
  );
  return { videos: row?.videos ?? 0, detailed: row?.detailed ?? 0 };
}
