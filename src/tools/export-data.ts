import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { coverageSchema } from '../harvest-schemas.js';
import { DEFAULT_EXPORT_ROWS, MAX_EXPORT_ROWS, exportData } from '../utils/export-data.js';
import { fileResult } from '../utils/format.js';
import { getStore } from '../utils/store.js';

const MIME = {
  json: 'application/json',
  csv: 'text/csv',
  markdown: 'text/markdown',
} as const;

export const exportDataSchema = {
  dataset: z
    .enum(['videos', 'comments'])
    .describe('What to export from the local store: catalogued videos, or harvested comments'),
  format: z
    .enum(['json', 'csv', 'markdown'])
    .default('json')
    .describe(
      'json keeps everything and carries the receipts inside; csv opens in a spreadsheet, with the receipts in a .coverage.json file beside it; markdown is for reading. Default: json'
    ),
  channel: z.string().max(64).optional().describe('Only this channel id'),
  video: z.string().max(32).optional().describe('Only this video id. Comments only'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_EXPORT_ROWS)
    .default(DEFAULT_EXPORT_ROWS)
    .describe(
      `Most rows to write (max ${MAX_EXPORT_ROWS.toLocaleString('en-US')}). Default: ${DEFAULT_EXPORT_ROWS.toLocaleString('en-US')}`
    ),
  outputDir: z
    .string()
    .optional()
    .describe('Where to write the file. Must be inside your home directory.'),
};

export const exportDataOutputSchema = {
  filePath: z.string(),
  coveragePath: z.string().optional().describe('For csv: the file holding the receipts'),
  dataset: z.enum(['videos', 'comments']),
  format: z.enum(['json', 'csv', 'markdown']),
  rows: z.number().int().describe('Rows written'),
  total: z.number().int().describe('Rows that matched, written or not'),
  truncated: z.boolean().describe('True when the limit left matching rows out'),
  bytes: z.number().int(),
  coverage: z.array(coverageSchema).describe('The receipts for the rows in the file'),
  withoutReceipt: z
    .array(z.string())
    .describe('Receipts that should exist for these rows and do not, as scope:id'),
  omittedReceipts: z.number().int().describe('Receipts left out of the list, past its limit'),
};

export interface ExportDataArgs {
  dataset: 'videos' | 'comments';
  format: 'json' | 'csv' | 'markdown';
  channel?: string;
  video?: string;
  limit: number;
  outputDir?: string;
}

/**
 * Writes harvested data to a file, with the receipts that say how whole it is.
 * Local only: it reads the store and writes to disk.
 */
export async function exportDataHandler(args: ExportDataArgs): Promise<CallToolResult> {
  const store = await getStore();
  const result = await exportData(store, args);

  const incomplete = result.coverage.filter((receipt) => !receipt.complete).length;
  const lines = [
    `✓ Exported ${result.rows.toLocaleString('en-US')} of ${result.total.toLocaleString('en-US')} ${result.dataset} (${result.format})`,
    '',
    result.filePath,
    ...(result.coveragePath === undefined ? [] : [`Receipts: ${result.coveragePath}`]),
    ...(result.truncated
      ? [
          '',
          `The limit left ${(result.total - result.rows).toLocaleString('en-US')} matching rows out. Raise limit to export more.`,
        ]
      : []),
    '',
    ...(result.coverage.length === 0
      ? []
      : incomplete === 0
        ? ['Every receipt for these rows is complete.']
        : [
            `${String(incomplete)} of ${String(result.coverage.length)} receipts ${incomplete === 1 ? 'is' : 'are'} incomplete.`,
            `Do not describe this file as the full ${result.dataset === 'videos' ? 'video list' : 'comment history'}.`,
          ]),
    ...(result.withoutReceipt.length === 0
      ? []
      : [
          `No receipt for: ${result.withoutReceipt.join(', ')}. How whole those rows are is unknown.`,
        ]),
    ...(result.omittedReceipts === 0
      ? []
      : [`${String(result.omittedReceipts)} further receipts are not listed here.`]),
  ];

  return fileResult(
    lines.join('\n').trimEnd(),
    {
      filePath: result.filePath,
      ...(result.coveragePath === undefined ? {} : { coveragePath: result.coveragePath }),
      dataset: result.dataset,
      format: result.format,
      rows: result.rows,
      total: result.total,
      truncated: result.truncated,
      bytes: result.bytes,
      coverage: result.coverage,
      withoutReceipt: result.withoutReceipt,
      omittedReceipts: result.omittedReceipts,
    },
    { path: result.filePath, name: `${result.dataset} export`, mimeType: MIME[result.format] }
  );
}
