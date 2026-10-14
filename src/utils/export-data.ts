import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Coverage } from '../harvest-schemas.js';
import { renderCoverage } from './coverage-text.js';
import { YouTubeError } from './errors.js';
import { toCsv, toMarkdownTable } from './export-format.js';
import { loadComments, loadVideos, type Loaded } from './export-load.js';
import { COMMENT_COLUMNS, VIDEO_COLUMNS } from './export-rows.js';
import { writeFileAtomic, writeJsonAtomic } from './json-file.js';
import { dataDir } from './paths.js';
import { assertChannelId, assertVideoId, resolveOutputDir } from './validate.js';

/**
 * Taking harvested data out of the store, as a file.
 *
 * What is harvested is only as whole as its receipt says, and a file is read without
 * the tool that made it. So an export carries its receipts with it: inside the file
 * for JSON and Markdown, and beside it for CSV, which has nowhere to put them.
 */

export const DEFAULT_EXPORT_ROWS = 10_000;
export const MAX_EXPORT_ROWS = 100_000;

/** Resolved per call, not at import, so the home directory is the one in force when it runs. */
function exportsDir(): string {
  return dataDir('exports');
}

export type ExportDataset = 'videos' | 'comments';
export type ExportFormat = 'json' | 'csv' | 'markdown';

export interface ExportRequest {
  dataset: ExportDataset;
  format: ExportFormat;
  /** Restrict to one channel id. */
  channel?: string;
  /** Restrict to one video id; comments only. */
  video?: string;
  limit: number;
  outputDir?: string;
}

export interface ExportResult {
  filePath: string;
  /** Present for CSV: where the receipts went, since a CSV cannot hold them. */
  coveragePath?: string;
  dataset: ExportDataset;
  format: ExportFormat;
  rows: number;
  total: number;
  truncated: boolean;
  coverage: Coverage[];
  /** Receipts that should exist for these rows and do not, as `scope:id`. */
  withoutReceipt: string[];
  /** Receipts left out of the list, past the limit a result carries. */
  omittedReceipts: number;
  bytes: number;
}

function csv(loaded: Loaded): string {
  return loaded.dataset === 'videos'
    ? toCsv(VIDEO_COLUMNS, loaded.rows)
    : toCsv(COMMENT_COLUMNS, loaded.rows);
}

function markdownTable(loaded: Loaded): string {
  return loaded.dataset === 'videos'
    ? toMarkdownTable(VIDEO_COLUMNS, loaded.rows)
    : toMarkdownTable(COMMENT_COLUMNS, loaded.rows);
}

function markdown(loaded: Loaded, truncated: boolean): string {
  const { receipts } = loaded;

  return [
    `# ${loaded.dataset === 'videos' ? 'Videos' : 'Comments'}`,
    '',
    `${String(loaded.rows.length)} of ${String(loaded.total)} rows${truncated ? ' (truncated by the limit)' : ''}.`,
    '',
    '## Completeness',
    '',
    ...(receipts.coverage.length === 0
      ? ['No receipt covers these rows, so how much of the source they are is unknown.']
      : receipts.coverage.flatMap((receipt) => [renderCoverage(receipt), ''])),
    ...(receipts.withoutReceipt.length === 0
      ? []
      : [`No receipt for: ${receipts.withoutReceipt.join(', ')}`, '']),
    ...(receipts.omittedReceipts === 0
      ? []
      : [`${String(receipts.omittedReceipts)} further receipts are not listed.`, '']),
    markdownTable(loaded),
    '',
  ].join('\n');
}

export async function exportData(
  database: DatabaseSync,
  request: ExportRequest
): Promise<ExportResult> {
  if (request.channel !== undefined) assertChannelId(request.channel);
  if (request.video !== undefined) {
    if (request.dataset !== 'comments') {
      throw new YouTubeError('INVALID_INPUT', 'video only applies when exporting comments.', {
        nextStep: 'Pass channel to restrict a video export, or export dataset comments.',
      });
    }
    assertVideoId(request.video);
  }
  const targetDir = resolveOutputDir(request.outputDir, exportsDir());

  const loaded =
    request.dataset === 'videos' ? loadVideos(database, request) : loadComments(database, request);
  const truncated = loaded.rows.length < loaded.total;

  const base = `${request.dataset}-${request.video ?? request.channel ?? 'all'}`;
  const extension = request.format === 'markdown' ? 'md' : request.format;
  const filePath = join(targetDir, `${base}.${extension}`);
  const meta = {
    exportedAt: new Date().toISOString(),
    dataset: request.dataset,
    filters: {
      ...(request.channel === undefined ? {} : { channel: request.channel }),
      ...(request.video === undefined ? {} : { video: request.video }),
    },
    total: loaded.total,
    exported: loaded.rows.length,
    truncated,
    coverage: loaded.receipts.coverage,
    withoutReceipt: loaded.receipts.withoutReceipt,
    omittedReceipts: loaded.receipts.omittedReceipts,
  };

  await mkdir(targetDir, { recursive: true });
  let coveragePath: string | undefined;

  if (request.format === 'json') {
    await writeJsonAtomic(filePath, { ...meta, rows: loaded.rows });
  } else if (request.format === 'markdown') {
    await writeFileAtomic(filePath, markdown(loaded, truncated));
  } else {
    await writeFileAtomic(filePath, csv(loaded));
    coveragePath = join(targetDir, `${base}.coverage.json`);
    await writeJsonAtomic(coveragePath, meta);
  }

  return {
    filePath,
    ...(coveragePath === undefined ? {} : { coveragePath }),
    dataset: request.dataset,
    format: request.format,
    rows: loaded.rows.length,
    total: loaded.total,
    truncated,
    coverage: loaded.receipts.coverage,
    withoutReceipt: loaded.receipts.withoutReceipt,
    omittedReceipts: loaded.receipts.omittedReceipts,
    bytes: (await stat(filePath)).size,
  };
}
