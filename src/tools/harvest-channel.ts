import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toolResult } from '../utils/format.js';
import { getStore } from '../utils/store.js';
import { harvestCatalog, MAX_VIDEOS_PER_CATALOG } from '../utils/harvest-catalog.js';
import { renderCoverage } from '../utils/coverage-text.js';
import { coverageSchema } from '../harvest-schemas.js';

export const harvestChannelSchema = {
  channel: z.string().max(256).describe('Channel URL, @handle, or channel id'),
  maxVideos: z
    .number()
    .int()
    .min(1)
    .max(MAX_VIDEOS_PER_CATALOG)
    .default(500)
    .describe(
      `Ceiling on videos to catalogue across all tabs (max ${String(MAX_VIDEOS_PER_CATALOG)}). ` +
        'Reaching it makes the result provably incomplete, and the receipt says so.'
    ),
};

export const harvestChannelOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  handle: z.string(),
  videosSeen: z.number().int().describe('Distinct videos in the catalogue after this call'),
  videosAdded: z.number().int().describe('Videos this call had not seen before'),
  tabs: z.array(
    z.object({
      tab: z.string(),
      listed: z.number().int(),
      added: z.number().int(),
      complete: z.boolean(),
      error: z.string().optional(),
    })
  ),
  coverage: coverageSchema,
};

/**
 * Catalogues every video a channel lists, across every tab.
 *
 * Calling it again continues rather than duplicating: videos are keyed on
 * their id and upserted, so a re-run costs requests and never data.
 */
export async function harvestChannelHandler({
  channel,
  maxVideos,
}: {
  channel: string;
  maxVideos: number;
}): Promise<CallToolResult> {
  const store = await getStore();

  // harvestCatalog takes the per-channel lock itself, once it has resolved the
  // id the lock is keyed on.
  const result = await harvestCatalog(store, channel, { maxVideos });

  const lines = [
    renderCoverage(result.coverage),
    '',
    `${result.name} (${result.handle}): ${String(result.videosSeen)} videos catalogued, ${String(result.videosAdded)} new.`,
    ...result.tabs.map((tab) =>
      tab.error === undefined
        ? `  ${tab.tab}: ${String(tab.listed)} listed${tab.complete ? '' : ' (capped)'}`
        : `  ${tab.tab}: ${tab.error}`
    ),
  ];

  return toolResult(lines.join('\n'), {
    channelId: result.channelId,
    name: result.name,
    handle: result.handle,
    videosSeen: result.videosSeen,
    videosAdded: result.videosAdded,
    tabs: result.tabs,
    coverage: result.coverage,
  });
}
