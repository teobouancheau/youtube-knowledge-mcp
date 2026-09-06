import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ThreadedComment, CommentThread } from './comment-threads.js';
import { queryRows, sqliteBoolean } from './store-rows.js';

/**
 * Comments on disk.
 *
 * Upserted on the comment id, never INSERT OR REPLACE: replace deletes and
 * reinserts, which changes the rowid the external-content FTS index is keyed
 * on. Upsert keeps it and fires the update trigger, so a re-harvest costs
 * network and never data.
 */

export const COMMENT_COMMIT_BATCH = 2_000;

const UPSERT = `
INSERT INTO comment (
  comment_id, video_id, parent_id, text, like_count, author, author_id, author_url,
  author_thumbnail, author_is_uploader, author_is_verified, is_pinned, is_favorited,
  time_text, published_at, harvested_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(comment_id) DO UPDATE SET
  text = excluded.text,
  like_count = excluded.like_count,
  is_pinned = excluded.is_pinned,
  is_favorited = excluded.is_favorited,
  harvested_at = excluded.harvested_at`;

const commentRowSchema = z.object({
  comment_id: z.string(),
  video_id: z.string(),
  parent_id: z.string().nullable(),
  text: z.string(),
  like_count: z.number(),
  author: z.string(),
  author_id: z.string().nullable(),
  author_is_uploader: sqliteBoolean,
  author_is_verified: sqliteBoolean,
  is_pinned: sqliteBoolean,
  is_favorited: sqliteBoolean,
  published_at: z.number().nullable(),
});

export type StoredComment = z.infer<typeof commentRowSchema>;

function bind(comment: ThreadedComment, videoId: string, now: number): (string | number | null)[] {
  return [
    comment.id,
    videoId,
    comment.parentId,
    comment.text,
    comment.likeCount,
    comment.author,
    comment.authorId ?? null,
    comment.authorUrl ?? null,
    comment.authorThumbnailUrl ?? null,
    Number(comment.authorIsUploader),
    Number(comment.authorIsVerified),
    Number(comment.isPinned),
    Number(comment.isFavorited),
    comment.timeText ?? null,
    comment.timestamp ?? null,
    now,
  ];
}

/** Writes threads and their replies. The caller owns the transaction. */
export function saveThreads(
  database: DatabaseSync,
  videoId: string,
  threads: CommentThread[],
  now = Date.now()
): number {
  const statement = database.prepare(UPSERT);
  let written = 0;

  for (const thread of threads) {
    statement.run(...bind(thread.comment, videoId, now));
    written += 1;
    for (const reply of thread.replies) {
      statement.run(...bind(reply, videoId, now));
      written += 1;
    }
  }

  return written;
}

export interface CommentQuery {
  videoId?: string;
  channelId?: string;
  match?: string;
  authorId?: string;
  minLikes?: number;
  topLevelOnly?: boolean;
  threadOf?: string;
  order?: 'likes' | 'newest' | 'oldest' | 'relevance';
  limit?: number;
  offset?: number;
}

function buildWhere(query: CommentQuery): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (query.videoId !== undefined) {
    clauses.push('c.video_id = ?');
    params.push(query.videoId);
  }
  if (query.channelId !== undefined) {
    clauses.push('c.video_id IN (SELECT video_id FROM video WHERE channel_id = ?)');
    params.push(query.channelId);
  }
  if (query.authorId !== undefined) {
    clauses.push('(c.author_id = ? OR c.author = ?)');
    params.push(query.authorId, query.authorId);
  }
  if (query.threadOf !== undefined) {
    clauses.push('(c.comment_id = ? OR c.parent_id = ?)');
    params.push(query.threadOf, query.threadOf);
  }
  if (query.topLevelOnly === true) clauses.push('c.parent_id IS NULL');
  if (query.minLikes !== undefined && query.minLikes > 0) {
    clauses.push('c.like_count >= ?');
    params.push(query.minLikes);
  }
  if (query.match !== undefined && query.match !== '') {
    // Bound, never concatenated: `match` is caller text and FTS5 has its own
    // expression syntax that must not reach the SQL parser.
    clauses.push('c.rowid IN (SELECT rowid FROM comment_fts WHERE comment_fts MATCH ?)');
    params.push(query.match);
  }

  return { sql: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`, params };
}

const ORDER: Record<NonNullable<CommentQuery['order']>, string> = {
  likes: 'c.like_count DESC, c.comment_id',
  newest: 'c.published_at DESC, c.comment_id',
  oldest: 'c.published_at ASC, c.comment_id',
  // Threads read in reply order; relevance needs the FTS rank, which only
  // exists when a match was given, so it falls back to likes.
  relevance: 'c.like_count DESC, c.comment_id',
};

export function queryComments(database: DatabaseSync, query: CommentQuery): StoredComment[] {
  const where = buildWhere(query);
  const order =
    query.threadOf === undefined
      ? ORDER[query.order ?? 'likes']
      : 'c.parent_id NULLS FIRST, c.published_at';

  return queryRows(
    database.prepare(
      `SELECT c.comment_id, c.video_id, c.parent_id, c.text, c.like_count, c.author,
              c.author_id, c.author_is_uploader, c.author_is_verified, c.is_pinned,
              c.is_favorited, c.published_at
       FROM comment c${where.sql}
       ORDER BY ${order} LIMIT ? OFFSET ?`
    ),
    commentRowSchema,
    ...where.params,
    query.limit ?? 25,
    query.offset ?? 0
  );
}

export function countComments(database: DatabaseSync, query: CommentQuery): number {
  const where = buildWhere(query);
  const rows = queryRows(
    database.prepare(`SELECT COUNT(*) AS n FROM comment c${where.sql}`),
    z.object({ n: z.number() }),
    ...where.params
  );
  return rows[0]?.n ?? 0;
}
