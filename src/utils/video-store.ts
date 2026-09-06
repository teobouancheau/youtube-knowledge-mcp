import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { queryRows } from './store-rows.js';

/**
 * Reading the catalogued videos back.
 *
 * `upload_date` is NULL, never '', for a video only ever seen in a flat
 * listing — flat entries carry no publication date. A date filter therefore
 * excludes those rows rather than silently treating them as ancient.
 */

const videoRowSchema = z.object({
  video_id: z.string(),
  channel_id: z.string().nullable(),
  title: z.string(),
  duration_s: z.number().nullable(),
  upload_date: z.string().nullable(),
  view_count: z.number().nullable(),
  comment_count: z.number().nullable(),
  live_status: z.string().nullable(),
  thumbnail_url: z.string().nullable(),
  tab: z.string().nullable(),
  also_in_tabs: z.string(),
  detail_at: z.number().nullable(),
  stored_comments: z.number(),
});

export type StoredVideo = z.infer<typeof videoRowSchema>;

export interface VideoQuery {
  channelId?: string;
  match?: string;
  since?: string;
  until?: string;
  minDurationSeconds?: number;
  detailedOnly?: boolean;
  withComments?: boolean;
  order?: 'newest' | 'oldest' | 'views' | 'comments' | 'catalog';
  limit?: number;
  offset?: number;
}

function buildWhere(query: VideoQuery): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (query.channelId !== undefined) {
    clauses.push('v.channel_id = ?');
    params.push(query.channelId);
  }
  if (query.match !== undefined && query.match !== '') {
    clauses.push('lower(v.title) LIKE ?');
    params.push(`%${query.match.toLowerCase()}%`);
  }
  if (query.since !== undefined) {
    clauses.push('v.upload_date IS NOT NULL AND v.upload_date >= ?');
    params.push(query.since.replace(/-/g, ''));
  }
  if (query.until !== undefined) {
    clauses.push('v.upload_date IS NOT NULL AND v.upload_date <= ?');
    params.push(query.until.replace(/-/g, ''));
  }
  if (query.minDurationSeconds !== undefined && query.minDurationSeconds > 0) {
    clauses.push('v.duration_s >= ?');
    params.push(query.minDurationSeconds);
  }
  if (query.detailedOnly === true) clauses.push('v.detail_at IS NOT NULL');
  if (query.withComments === true) {
    clauses.push('EXISTS (SELECT 1 FROM comment c WHERE c.video_id = v.video_id)');
  }

  return { sql: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`, params };
}

const ORDER: Record<NonNullable<VideoQuery['order']>, string> = {
  // NULLS LAST so an un-dated video sorts as unknown rather than oldest.
  newest: 'v.upload_date DESC NULLS LAST, v.video_id',
  oldest: 'v.upload_date ASC NULLS LAST, v.video_id',
  views: 'v.view_count DESC NULLS LAST, v.video_id',
  comments: 'stored_comments DESC, v.video_id',
  catalog: 'v.catalog_rank ASC NULLS LAST, v.video_id',
};

const SELECT = `
SELECT v.video_id, v.channel_id, v.title, v.duration_s, v.upload_date, v.view_count,
       v.comment_count, v.live_status, v.thumbnail_url, v.tab, v.also_in_tabs, v.detail_at,
       (SELECT COUNT(*) FROM comment c WHERE c.video_id = v.video_id) AS stored_comments
FROM video v`;

export function queryVideos(database: DatabaseSync, query: VideoQuery): StoredVideo[] {
  const where = buildWhere(query);

  return queryRows(
    database.prepare(
      `${SELECT}${where.sql} ORDER BY ${ORDER[query.order ?? 'newest']} LIMIT ? OFFSET ?`
    ),
    videoRowSchema,
    ...where.params,
    query.limit ?? 25,
    query.offset ?? 0
  );
}

export function countVideos(database: DatabaseSync, query: VideoQuery): number {
  const where = buildWhere(query);
  const rows = queryRows(
    database.prepare(`SELECT COUNT(*) AS n FROM video v${where.sql}`),
    z.object({ n: z.number() }),
    ...where.params
  );
  return rows[0]?.n ?? 0;
}
