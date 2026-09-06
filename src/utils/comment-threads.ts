import type { z } from 'zod';
import type { commentRowSchema } from './youtube-schemas.js';

/**
 * Rebuilding threads from yt-dlp's flat comment array.
 *
 * yt-dlp returns replies alongside their parents and marks each with a
 * `parent` of `root` or the parent's id. The previous implementation filtered
 * the replies away *after* paying to fetch them, which is the most expensive
 * possible way to have no replies.
 */

export type CommentRow = z.infer<typeof commentRowSchema>;

export interface ThreadedComment {
  id: string;
  parentId: string | null;
  author: string;
  authorId?: string;
  authorUrl?: string;
  authorThumbnailUrl?: string;
  authorIsUploader: boolean;
  authorIsVerified: boolean;
  text: string;
  likeCount: number;
  isPinned: boolean;
  isFavorited: boolean;
  timestamp?: number;
  publishedAt?: string;
  timeText?: string;
}

export interface CommentThread {
  comment: ThreadedComment;
  replies: ThreadedComment[];
  /** Replies present in THIS extraction, not YouTube's own figure. */
  replyCount: number;
}

export interface ThreadedComments {
  threads: CommentThread[];
  rootCount: number;
  replyCount: number;
  /** Replies whose parent was cut by a cap. Kept, and counted, never dropped. */
  orphanCount: number;
}

function toComment(row: CommentRow, index: number): ThreadedComment {
  const parent = row.parent ?? 'root';
  const timestamp = row.timestamp ?? undefined;
  // yt-dlp writes null for an absent field; normalised to undefined once here
  // so every spread below is a plain `=== undefined` check.
  const authorId = row.author_id ?? undefined;
  const authorUrl = row.author_url ?? undefined;
  const authorThumbnail = row.author_thumbnail ?? undefined;
  const timeText = row._time_text ?? undefined;

  return {
    // yt-dlp always supplies an id; the fallback keeps a malformed row
    // addressable rather than silently merging it with another.
    id: row.id ?? `unknown-${String(index)}`,
    parentId: parent === 'root' ? null : parent,
    author: row.author ?? 'Unknown',
    ...(authorId === undefined ? {} : { authorId }),
    ...(authorUrl === undefined ? {} : { authorUrl }),
    ...(authorThumbnail === undefined ? {} : { authorThumbnailUrl: authorThumbnail }),
    authorIsUploader: row.author_is_uploader ?? false,
    authorIsVerified: row.author_is_verified ?? false,
    text: row.text ?? '',
    likeCount: row.like_count ?? 0,
    isPinned: row.is_pinned ?? false,
    isFavorited: row.is_favorited ?? false,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(timestamp === undefined ? {} : { publishedAt: new Date(timestamp * 1000).toISOString() }),
    ...(timeText === undefined ? {} : { timeText }),
  };
}

/**
 * Groups rows into threads, in yt-dlp's own order.
 *
 * A reply whose parent is missing — because `max_parents` truncated the set —
 * is promoted to a root rather than discarded, keeping its `parentId` so the
 * gap stays visible. Silently dropping data is the bug this whole release is
 * about.
 */
export function toThreads(rows: CommentRow[]): ThreadedComments {
  const comments = rows.map(toComment);
  const threads: CommentThread[] = [];
  const threadById = new Map<string, CommentThread>();
  let replyCount = 0;
  let orphanCount = 0;

  for (const comment of comments) {
    if (comment.parentId === null) {
      const thread = { comment, replies: [], replyCount: 0 };
      threads.push(thread);
      threadById.set(comment.id, thread);
    }
  }

  for (const comment of comments) {
    if (comment.parentId === null) continue;

    const thread = threadById.get(comment.parentId);
    if (thread === undefined) {
      // The parent was cut by a cap. Keep the reply as its own thread so the
      // text survives, and count it so the caller knows threads are partial.
      orphanCount += 1;
      threads.push({ comment, replies: [], replyCount: 0 });
      continue;
    }

    thread.replies.push(comment);
    thread.replyCount += 1;
    replyCount += 1;
  }

  for (const thread of threads) {
    thread.replies.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
  }

  return {
    threads,
    rootCount: threads.length - orphanCount,
    replyCount,
    orphanCount,
  };
}
