import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatYouTubeDate, toolResult } from '../utils/format.js';
import { getStore } from '../utils/store.js';
import { DEFAULT_LOOKBACK, MAX_LOOKBACK, checkNewUploads } from '../utils/upload-check.js';

export const checkNewUploadsSchema = {
  channel: z.string().max(256).describe('Channel URL, @handle, or channel id, already catalogued'),
  lookback: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOOKBACK)
    .default(DEFAULT_LOOKBACK)
    .describe(
      `How many of the newest videos of each tab to compare against the catalogue (max ${String(MAX_LOOKBACK)}). Raise it if the catalogue is old. Default: ${String(DEFAULT_LOOKBACK)}`
    ),
};

export const checkNewUploadsOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  lookback: z.number().int(),
  checked: z.array(
    z.object({ tab: z.string(), listed: z.number().int(), error: z.string().optional() })
  ),
  newCount: z.number().int(),
  newVideos: z.array(
    z.object({
      videoId: z.string(),
      title: z.string(),
      tab: z.string(),
      url: z.string(),
      durationSeconds: z.number().optional(),
    })
  ),
  catalogHarvestedAt: z.string().optional(),
  catalogComplete: z
    .boolean()
    .describe('Whether the catalogue this was compared against was provably whole'),
};

/**
 * What a channel has published that the catalogue does not hold. Compares and reports;
 * adding the videos is harvest_channel's job.
 */
export async function checkNewUploadsHandler(args: {
  channel: string;
  lookback: number;
}): Promise<CallToolResult> {
  const store = await getStore();
  const check = await checkNewUploads(store, args.channel, { lookback: args.lookback });

  const written =
    check.catalogHarvestedAt === undefined
      ? 'the catalogue'
      : `the catalogue written ${formatYouTubeDate(check.catalogHarvestedAt.slice(0, 10).replace(/-/g, ''))}`;
  const count = check.newVideos.length;

  const lines = [
    count === 0
      ? `Nothing new in the latest ${String(check.lookback)} of each tab of ${check.name}, compared with ${written}.`
      : `${check.name}: ${count === 1 ? '1 new video' : `${String(count)} new videos`} in the latest ${String(check.lookback)} of each tab, compared with ${written}.`,
    ...(check.catalogComplete
      ? []
      : ['The catalogue was not complete, so a video it lacks may be old rather than new.']),
    ...check.checked
      .filter((tab) => tab.error !== undefined)
      .map((tab) => `${tab.tab}: could not be checked (${tab.error ?? ''})`),
    '',
    ...check.newVideos.flatMap((video, index) => [
      `${String(index + 1)}. ${video.title} [${video.tab}]`,
      `   ${video.url}`,
    ]),
    ...(count > 0 ? ['', 'Call harvest_channel to add them to the catalogue.'] : []),
  ];

  return toolResult(lines.join('\n').trimEnd(), {
    channelId: check.channelId,
    name: check.name,
    lookback: check.lookback,
    checked: check.checked,
    newCount: count,
    newVideos: check.newVideos,
    ...(check.catalogHarvestedAt === undefined
      ? {}
      : { catalogHarvestedAt: check.catalogHarvestedAt }),
    catalogComplete: check.catalogComplete,
  });
}
