import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toolResult } from '../utils/format.js';
import { closeStore, getStore, quarantineStore } from '../utils/store.js';
import { readStoreHealth } from '../utils/store-health.js';

export const repairStoreSchema = {
  confirm: z
    .literal(true)
    .describe(
      'Must be true. If the store is damaged this moves it aside and starts an empty one; ' +
        'harvested comments cost hours of network and cannot be recovered from any local cache.'
    ),
};

export const repairStoreOutputSchema = {
  wasCorrupt: z.boolean(),
  integrity: z.enum(['ok', 'failed', 'unchecked']),
  movedTo: z
    .string()
    .optional()
    .describe('Where the damaged file was moved. Absent if it was healthy.'),
  lost: z.object({
    channels: z.number().int(),
    videos: z.number().int(),
    comments: z.number().int(),
  }),
  storePath: z.string(),
};

/**
 * Moves a damaged store aside and starts a fresh one.
 *
 * Deliberately not automatic. `search-index.json` is rebuilt from disk without
 * asking because it is derivable; this is not — it is the only copy of data
 * that took hours of network to collect. So the damaged file is renamed rather
 * than deleted, and the report says what was in it.
 */
export async function repairStoreHandler(): Promise<CallToolResult> {
  const before = await readStoreHealth();

  if (before.integrity === 'ok') {
    return toolResult(
      `Store is healthy (quick_check ok): ${String(before.videos)} videos, ${String(before.comments)} comments. Nothing to repair.`,
      {
        wasCorrupt: false,
        integrity: before.integrity,
        lost: { channels: before.channels, videos: before.videos, comments: before.comments },
        storePath: before.path,
      }
    );
  }

  const movedTo = await quarantineStore();
  closeStore();
  // Re-opening recreates the schema, so the next harvest starts cleanly.
  await getStore();

  const lost = {
    channels: before.channels,
    videos: before.videos,
    comments: before.comments,
  };

  return toolResult(
    [
      `Store was ${before.integrity === 'failed' ? 'corrupt' : 'unreadable'}. Moved it to ${movedTo} and created a fresh one.`,
      `Lost from the working store: ${String(lost.videos)} videos, ${String(lost.comments)} comments, ${String(lost.channels)} channels.`,
      'The damaged file was kept, not deleted. Re-run the harvests you need.',
    ].join('\n'),
    { wasCorrupt: true, integrity: before.integrity, movedTo, lost, storePath: before.path }
  );
}
