import { z } from 'zod';
import type { StoredComment } from './comment-store.js';
import type { Column } from './export-format.js';
import type { StoredVideo } from './video-store.js';

/** The rows an export holds, as they are written, and the columns a CSV or table gives them. */

export interface VideoRow {
  videoId: string;
  channelId?: string;
  title: string;
  durationSeconds?: number;
  uploadDate?: string;
  viewCount?: number;
  commentCount?: number;
  tab?: string;
  alsoInTabs: string[];
  detailed: boolean;
  storedComments: number;
}

export interface CommentRow {
  commentId: string;
  videoId: string;
  parentId?: string;
  author: string;
  authorId?: string;
  likeCount: number;
  isPinned: boolean;
  isUploader: boolean;
  isVerified: boolean;
  publishedAt?: string;
  text: string;
}

export const VIDEO_COLUMNS: Column<VideoRow>[] = [
  { header: 'videoId', value: (row) => row.videoId, verbatim: true },
  { header: 'channelId', value: (row) => row.channelId, verbatim: true },
  { header: 'title', value: (row) => row.title },
  { header: 'durationSeconds', value: (row) => row.durationSeconds },
  { header: 'uploadDate', value: (row) => row.uploadDate },
  { header: 'viewCount', value: (row) => row.viewCount },
  { header: 'commentCount', value: (row) => row.commentCount },
  { header: 'tab', value: (row) => row.tab },
  { header: 'alsoInTabs', value: (row) => row.alsoInTabs.join(' ') },
  { header: 'detailed', value: (row) => row.detailed },
  { header: 'storedComments', value: (row) => row.storedComments },
];

export const COMMENT_COLUMNS: Column<CommentRow>[] = [
  { header: 'commentId', value: (row) => row.commentId, verbatim: true },
  { header: 'videoId', value: (row) => row.videoId, verbatim: true },
  { header: 'parentId', value: (row) => row.parentId, verbatim: true },
  { header: 'author', value: (row) => row.author },
  { header: 'authorId', value: (row) => row.authorId, verbatim: true },
  { header: 'likeCount', value: (row) => row.likeCount },
  { header: 'isPinned', value: (row) => row.isPinned },
  { header: 'isUploader', value: (row) => row.isUploader },
  { header: 'isVerified', value: (row) => row.isVerified },
  { header: 'publishedAt', value: (row) => row.publishedAt },
  { header: 'text', value: (row) => row.text },
];

/** The tabs column is JSON written by SQLite; a damaged value reads as no extra tabs. */
function alsoInTabs(json: string): string[] {
  try {
    return z.array(z.string()).catch([]).parse(JSON.parse(json));
  } catch {
    return [];
  }
}

export function toVideoRow(row: StoredVideo): VideoRow {
  return {
    videoId: row.video_id,
    ...(row.channel_id === null ? {} : { channelId: row.channel_id }),
    title: row.title,
    ...(row.duration_s === null ? {} : { durationSeconds: row.duration_s }),
    ...(row.upload_date === null ? {} : { uploadDate: row.upload_date }),
    ...(row.view_count === null ? {} : { viewCount: row.view_count }),
    ...(row.comment_count === null ? {} : { commentCount: row.comment_count }),
    ...(row.tab === null ? {} : { tab: row.tab }),
    alsoInTabs: alsoInTabs(row.also_in_tabs),
    detailed: row.detail_at !== null,
    storedComments: row.stored_comments,
  };
}

export function toCommentRow(row: StoredComment): CommentRow {
  return {
    commentId: row.comment_id,
    videoId: row.video_id,
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    author: row.author,
    ...(row.author_id === null ? {} : { authorId: row.author_id }),
    likeCount: row.like_count,
    isPinned: row.is_pinned,
    isUploader: row.author_is_uploader,
    isVerified: row.author_is_verified,
    ...(row.published_at === null
      ? {}
      : { publishedAt: new Date(row.published_at * 1000).toISOString() }),
    text: row.text,
  };
}
