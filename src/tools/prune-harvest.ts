import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toolResult } from '../utils/format.js';
import { getStore, inTransaction } from '../utils/store.js';
import { countRows } from '../utils/store-rows.js';

export const pruneHarvestSchema = {
  channel: z.string().max(64).optional().describe('Restrict to one channel id'),
  video: z.string().max(64).optional().describe('Restrict to one video id'),
  author: z
    .string()
    .max(256)
    .optional()
    .describe("Remove one author's comments everywhere. The erasure path for a person who asks."),
  scope: z.enum(['comments', 'catalog', 'all']).default('comments'),
  confirm: z
    .literal(true)
    .describe(
      'Must be true. Harvested comments cost hours of network that no local cache can replay.'
    ),
  vacuum: z
    .boolean()
    .default(false)
    .describe('Reclaim disk afterwards. Slow on a large store, and it blocks other writers.'),
};

export const pruneHarvestOutputSchema = {
  removed: z.object({
    comments: z.number().int(),
    videos: z.number().int(),
    channels: z.number().int(),
    receipts: z.number().int(),
  }),
  remaining: z.object({
    comments: z.number().int(),
    videos: z.number().int(),
    channels: z.number().int(),
  }),
  vacuumed: z.boolean(),
};

/**
 * Removes harvested data.
 *
 * The store holds personal data at scale — display names, channel ids and
 * free-text opinions from people who never used this tool — so a way to remove
 * it is a requirement, not a convenience. `author` is the per-person erasure
 * path; the other scopes are for reclaiming disk.
 */
export async function pruneHarvestHandler(input: {
  channel?: string;
  video?: string;
  author?: string;
  scope: 'comments' | 'catalog' | 'all';
  confirm: true;
  vacuum: boolean;
}): Promise<CallToolResult> {
  const store = await getStore();
  const count = (sql: string): number => countRows(store.prepare(sql));

  const before = {
    comments: count('SELECT COUNT(*) FROM comment'),
    videos: count('SELECT COUNT(*) FROM video'),
    channels: count('SELECT COUNT(*) FROM channel'),
    receipts: count('SELECT COUNT(*) FROM harvest_receipt'),
  };

  inTransaction(store, () => {
    if (input.author !== undefined) {
      store
        .prepare('DELETE FROM comment WHERE author_id = ? OR author = ?')
        .run(input.author, input.author);
      return;
    }

    if (input.scope !== 'catalog') {
      if (input.video !== undefined) {
        store.prepare('DELETE FROM comment WHERE video_id = ?').run(input.video);
        store
          .prepare("DELETE FROM harvest_receipt WHERE scope = 'video-comments' AND target_id = ?")
          .run(input.video);
      } else if (input.channel !== undefined) {
        store
          .prepare(
            'DELETE FROM comment WHERE video_id IN (SELECT video_id FROM video WHERE channel_id = ?)'
          )
          .run(input.channel);
      } else {
        store.exec('DELETE FROM comment');
        store.exec("DELETE FROM harvest_receipt WHERE scope = 'video-comments'");
      }
    }

    if (input.scope !== 'comments') {
      // ON DELETE CASCADE takes the videos, and their comments, with the channel.
      if (input.channel !== undefined) {
        store.prepare('DELETE FROM channel WHERE channel_id = ?').run(input.channel);
        store
          .prepare("DELETE FROM harvest_receipt WHERE scope = 'channel-catalog' AND target_id = ?")
          .run(input.channel);
      } else {
        store.exec('DELETE FROM channel');
        store.exec('DELETE FROM video');
        store.exec('DELETE FROM harvest_receipt');
      }
    }
  });

  if (input.vacuum) store.exec('VACUUM');

  const remaining = {
    comments: count('SELECT COUNT(*) FROM comment'),
    videos: count('SELECT COUNT(*) FROM video'),
    channels: count('SELECT COUNT(*) FROM channel'),
  };

  const removed = {
    comments: before.comments - remaining.comments,
    videos: before.videos - remaining.videos,
    channels: before.channels - remaining.channels,
    receipts: before.receipts - count('SELECT COUNT(*) FROM harvest_receipt'),
  };

  return toolResult(
    `Removed ${String(removed.comments)} comments, ${String(removed.videos)} videos and ${String(removed.channels)} channels. ` +
      `${String(remaining.comments)} comments remain.`,
    { removed, remaining, vacuumed: input.vacuum }
  );
}
