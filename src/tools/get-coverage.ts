import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toolResult, pageInfo } from '../utils/format.js';
import { paginationShape } from '../schemas.js';
import { coverageSchema, harvestScopeSchema } from '../harvest-schemas.js';
import { getStore } from '../utils/store.js';
import { countReceipts, listReceipts } from '../utils/harvest-receipts.js';
import { countRows } from '../utils/store-rows.js';
import { RECEIPT_STALE_MS } from '../utils/coverage.js';

export const getCoverageSchema = {
  scope: harvestScopeSchema.optional().describe('Restrict to one kind of harvest'),
  incompleteOnly: z
    .boolean()
    .default(false)
    .describe('Only receipts that are not provably complete'),
  verify: z
    .boolean()
    .default(true)
    .describe(
      'Recount the store and cross-check every receipt against it. A receipt that disagrees ' +
        'is reported in mismatches and treated as incomplete.'
    ),
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
};

export const getCoverageOutputSchema = {
  receipts: z.array(coverageSchema),
  anyIncomplete: z
    .boolean()
    .describe(
      'True when ANY receipt in scope is not provably complete. While this is true a consumer ' +
        'must not describe the data as a full history, for any part of it.'
    ),
  summary: z.object({
    complete: z.number().int(),
    incomplete: z.number().int(),
    stale: z.number().int().describe('Complete receipts past their staleAfter'),
  }),
  store: z.object({
    channels: z.number().int(),
    videos: z.number().int(),
    comments: z.number().int(),
  }),
  mismatches: z
    .array(
      z.object({
        scope: harvestScopeSchema,
        targetId: z.string(),
        receiptHave: z.number().int(),
        storeHave: z.number().int(),
      })
    )
    .describe(
      'Empty in normal operation. Non-empty means a receipt was wrong and is not to be trusted.'
    ),
  ...paginationShape,
};

/**
 * What this server can actually prove it holds.
 *
 * Reads only the local store and never contacts YouTube, so it is cheap enough
 * for a consumer to call before every claim it makes — which is the point.
 */
export async function getCoverageHandler({
  scope,
  incompleteOnly,
  verify,
  limit,
  offset,
}: {
  scope?: 'channel-catalog' | 'video-details' | 'video-comments';
  incompleteOnly: boolean;
  verify: boolean;
  limit: number;
  offset: number;
}): Promise<CallToolResult> {
  const store = await getStore();
  const all = listReceipts(store, { ...(scope === undefined ? {} : { scope }), limit, offset });
  const now = Date.now();

  const mismatches: {
    scope: 'channel-catalog' | 'video-details' | 'video-comments';
    targetId: string;
    receiptHave: number;
    storeHave: number;
  }[] = [];
  const receipts = all.map((receipt) => {
    if (!verify || receipt.scope !== 'video-comments') return receipt;

    const storeHave = countRows(
      store.prepare('SELECT COUNT(*) FROM comment WHERE video_id = ?'),
      receipt.targetId
    );
    if (storeHave === receipt.have) return receipt;

    // The store is the authority. A receipt that disagrees with it was written
    // by something this build did not do, so it loses its claim rather than
    // being believed.
    mismatches.push({
      scope: receipt.scope,
      targetId: receipt.targetId,
      receiptHave: receipt.have,
      storeHave,
    });
    return { ...receipt, complete: false, reason: 'PARTIAL_ERROR' as const, have: storeHave };
  });

  const shown = incompleteOnly ? receipts.filter((receipt) => !receipt.complete) : receipts;
  const stale = receipts.filter(
    (receipt) => receipt.complete && Date.parse(receipt.harvestedAt) + RECEIPT_STALE_MS < now
  ).length;
  const incomplete = receipts.filter((receipt) => !receipt.complete).length;

  const counts = {
    channels: countRows(store.prepare('SELECT COUNT(*) FROM channel')),
    videos: countRows(store.prepare('SELECT COUNT(*) FROM video')),
    comments: countRows(store.prepare('SELECT COUNT(*) FROM comment')),
  };

  const anyIncomplete = incomplete > 0;
  const lines = [
    anyIncomplete
      ? `INCOMPLETE: ${String(incomplete)} of ${String(receipts.length)} receipts are not provably complete. Do not describe this data as a full history.`
      : `All ${String(receipts.length)} receipts in scope are provably complete.`,
    `Store: ${String(counts.channels)} channels, ${String(counts.videos)} videos, ${String(counts.comments)} comments.`,
    ...(stale > 0 ? [`${String(stale)} complete receipts are past their re-check date.`] : []),
    ...(mismatches.length > 0
      ? [`${String(mismatches.length)} receipts disagreed with the store and were downgraded.`]
      : []),
  ];

  return toolResult(lines.join('\n'), {
    receipts: shown,
    anyIncomplete,
    summary: { complete: receipts.length - incomplete, incomplete, stale },
    store: counts,
    mismatches,
    ...pageInfo(countReceipts(store, scope), shown.length, offset),
  });
}
