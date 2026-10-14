import type { DatabaseSync } from 'node:sqlite';
import type { Coverage } from '../harvest-schemas.js';
import { countComments, queryComments } from './comment-store.js';
import { COVERAGE_IN_RESULT_LIMIT } from './coverage.js';
import { toCommentRow, toVideoRow, type CommentRow, type VideoRow } from './export-rows.js';
import { readReceipt } from './harvest-receipts.js';
import { countVideos, queryVideos } from './video-store.js';

/**
 * Reading the rows an export holds out of the store, and the receipts that say how whole they are.
 */

const PAGE = 1_000;

/** What is loaded: the part of an export request that decides which rows. */
export interface LoadRequest {
  channel?: string;
  video?: string;
  limit: number;
}

export interface Receipts {
  coverage: Coverage[];
  withoutReceipt: string[];
  omittedReceipts: number;
}

export type Loaded =
  | { dataset: 'videos'; rows: VideoRow[]; total: number; receipts: Receipts }
  | { dataset: 'comments'; rows: CommentRow[]; total: number; receipts: Receipts };

/** Pages through a query until `limit` rows, so memory holds rows and not a second copy of them. */
function collect<T>(limit: number, page: (offset: number, size: number) => T[]): T[] {
  const rows: T[] = [];
  while (rows.length < limit) {
    const got = page(rows.length, Math.min(PAGE, limit - rows.length));
    rows.push(...got);
    if (got.length === 0) break;
  }
  return rows;
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

/** The receipts for the targets in these rows, up to what a result carries. */
function receiptsFor(
  database: DatabaseSync,
  targets: { scope: Coverage['scope']; ids: string[]; required: boolean }[]
): Receipts {
  const coverage: Coverage[] = [];
  const withoutReceipt: string[] = [];
  let omittedReceipts = 0;

  for (const { scope, ids, required } of targets) {
    for (const id of ids.slice(0, COVERAGE_IN_RESULT_LIMIT)) {
      const receipt = readReceipt(database, scope, id);
      if (receipt !== undefined) coverage.push(receipt);
      else if (required) withoutReceipt.push(`${scope}:${id}`);
    }
    omittedReceipts += Math.max(0, ids.length - COVERAGE_IN_RESULT_LIMIT);
  }

  return { coverage, withoutReceipt, omittedReceipts };
}

export function loadVideos(database: DatabaseSync, request: LoadRequest): Loaded {
  const filter = request.channel === undefined ? {} : { channelId: request.channel };
  const rows = collect(request.limit, (offset, size) =>
    queryVideos(database, { ...filter, order: 'catalog', limit: size, offset }).map(toVideoRow)
  );
  const channels = unique([request.channel, ...rows.map((row) => row.channelId)]);

  return {
    dataset: 'videos',
    rows,
    total: countVideos(database, filter),
    receipts: receiptsFor(database, [
      { scope: 'channel-catalog', ids: channels, required: true },
      { scope: 'video-details', ids: channels, required: false },
    ]),
  };
}

export function loadComments(database: DatabaseSync, request: LoadRequest): Loaded {
  const filter = {
    ...(request.video === undefined ? {} : { videoId: request.video }),
    ...(request.channel === undefined ? {} : { channelId: request.channel }),
  };
  const rows = collect(request.limit, (offset, size) =>
    queryComments(database, { ...filter, order: 'oldest', limit: size, offset }).map(toCommentRow)
  );

  return {
    dataset: 'comments',
    rows,
    total: countComments(database, filter),
    receipts: receiptsFor(database, [
      { scope: 'video-comments', ids: unique(rows.map((row) => row.videoId)), required: true },
    ]),
  };
}
