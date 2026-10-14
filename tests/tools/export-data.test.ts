import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';
import { coverageOf } from '../../src/utils/coverage.js';

vi.mock('../../src/utils/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/store.js')>()),
  getStore: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../src/utils/export-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/export-data.js')>()),
  exportData: vi.fn(),
}));

import { exportData, type ExportResult } from '../../src/utils/export-data.js';
import { exportDataHandler } from '../../src/tools/export-data.js';

const CHANNEL = 'UCaaaaaaaaaaaaaaaaaaaaaa';

const complete = coverageOf({
  scope: 'channel-catalog',
  targetId: CHANNEL,
  have: 5,
  source: 'test',
  expected: { value: 5, source: 'source-exhausted' },
  ranToExhaustion: true,
});
const partial = coverageOf({
  scope: 'video-comments',
  targetId: 'aaaaaaaaaa1',
  have: 3,
  source: 'test',
  expected: { value: 10, source: 'youtube:comment_count' },
});

function exported(overrides: Partial<ExportResult> = {}): ExportResult {
  return {
    filePath: '/home/u/.youtube-knowledge/exports/videos-all.json',
    dataset: 'videos',
    format: 'json',
    rows: 5,
    total: 5,
    truncated: false,
    coverage: [complete],
    withoutReceipt: [],
    omittedReceipts: 0,
    bytes: 2048,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(exportData).mockResolvedValue(exported());
});

const args = { dataset: 'videos' as const, format: 'json' as const, limit: 1000 };

describe('exportDataHandler', () => {
  it('forwards the request as given', async () => {
    await exportDataHandler({ ...args, channel: CHANNEL, outputDir: '~/Exports' });

    expect(exportData).toHaveBeenCalledWith(expect.anything(), {
      ...args,
      channel: CHANNEL,
      outputDir: '~/Exports',
    });
  });

  it('reports the file, how many rows, and links to it with the right type', async () => {
    const result = await exportDataHandler(args);

    expect(structuredOf(result)).toMatchObject({
      filePath: '/home/u/.youtube-knowledge/exports/videos-all.json',
      rows: 5,
      total: 5,
      truncated: false,
      bytes: 2048,
    });
    expect(textOf(result)).toContain('5 of 5');
    expect(result.content.find((block) => block.type === 'resource_link')).toMatchObject({
      mimeType: 'application/json',
    });
  });

  it.each([
    ['csv', 'text/csv'],
    ['markdown', 'text/markdown'],
  ] as const)('links a %s export as %s', async (format, mimeType) => {
    vi.mocked(exportData).mockResolvedValue(exported({ format }));

    const result = await exportDataHandler({ ...args, format });

    expect(result.content.find((block) => block.type === 'resource_link')).toMatchObject({
      mimeType,
    });
  });

  it('says plainly when everything in the file is provably complete', async () => {
    const result = await exportDataHandler(args);

    expect(textOf(result)).toContain('Every receipt for these rows is complete');
  });

  it('says the file is not the whole story when a receipt is incomplete', async () => {
    vi.mocked(exportData).mockResolvedValue(exported({ coverage: [complete, partial] }));

    const text = textOf(await exportDataHandler(args));

    expect(text).toContain('1 of 2 receipts is incomplete');
    expect(text).toContain('Do not describe this file as the full');
  });

  it('says rows were left out by the limit, and how many exist', async () => {
    vi.mocked(exportData).mockResolvedValue(exported({ rows: 1000, total: 4200, truncated: true }));

    const text = textOf(await exportDataHandler(args));

    expect(text).toContain('1,000 of 4,200');
    expect(text).toContain('Raise limit');
  });

  it('names where a CSV’s receipts went, since a CSV cannot hold them', async () => {
    vi.mocked(exportData).mockResolvedValue(
      exported({
        format: 'csv',
        filePath: '/home/u/.youtube-knowledge/exports/videos-all.csv',
        coveragePath: '/home/u/.youtube-knowledge/exports/videos-all.coverage.json',
      })
    );

    const result = await exportDataHandler({ ...args, format: 'csv' });

    expect(textOf(result)).toContain('videos-all.coverage.json');
    expect(structuredOf(result)).toMatchObject({
      coveragePath: '/home/u/.youtube-knowledge/exports/videos-all.coverage.json',
    });
  });

  it('names rows with no receipt at all, whose completeness nobody can vouch for', async () => {
    vi.mocked(exportData).mockResolvedValue(
      exported({ coverage: [], withoutReceipt: ['channel-catalog:UCbbbbbbbbbbbbbbbbbbbbbb'] })
    );

    const text = textOf(await exportDataHandler(args));

    expect(text).toContain('No receipt for');
    expect(text).toContain('channel-catalog:UCbbbbbbbbbbbbbbbbbbbbbb');
  });
});
