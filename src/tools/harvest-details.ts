import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { coverageSchema } from '../harvest-schemas.js';
import { renderCoverage } from '../utils/coverage-text.js';
import { toolResult } from '../utils/format.js';
import {
  DEFAULT_DETAIL_BATCH,
  MAX_DETAIL_BATCH,
  harvestDetails,
} from '../utils/harvest-details.js';
import { getStore } from '../utils/store.js';

export const harvestDetailsSchema = {
  channel: z.string().max(256).describe('Channel URL, @handle, or channel id, already catalogued'),
  maxVideos: z
    .number()
    .int()
    .min(1)
    .max(MAX_DETAIL_BATCH)
    .default(DEFAULT_DETAIL_BATCH)
    .describe(
      `How many unread videos to read in this call (max ${String(MAX_DETAIL_BATCH)}). Each is a full read, the request YouTube throttles hardest, so run it in batches. Default: ${String(DEFAULT_DETAIL_BATCH)}`
    ),
  retryUnreadable: z
    .boolean()
    .default(false)
    .describe(
      'Try again the videos earlier runs found private, members-only, age-gated or removed. Worth it after adding cookies. Default: false'
    ),
};

export const harvestDetailsOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  attempted: z.number().int().describe('Videos read, or tried, in this call'),
  stored: z.number().int().describe('Videos whose full record was kept'),
  failures: z.array(z.object({ videoId: z.string(), code: z.string() })),
  remaining: z.number().int().describe('Videos still unread that can be read'),
  stoppedBecause: z
    .string()
    .optional()
    .describe('The refusal that ended the call early, when one did'),
  coverage: coverageSchema,
};

/**
 * Reads the full record of each catalogued video and keeps it in the store, a batch at a
 * time. Calling it again continues with the next unread videos.
 */
export async function harvestDetailsHandler(args: {
  channel: string;
  maxVideos: number;
  retryUnreadable: boolean;
}): Promise<CallToolResult> {
  const store = await getStore();
  const result = await harvestDetails(store, args.channel, {
    maxVideos: args.maxVideos,
    retryUnreadable: args.retryUnreadable,
  });

  const lines = [
    renderCoverage(result.coverage),
    '',
    `${result.name}: ${String(result.stored)} of ${String(result.attempted)} videos read this run, ${String(result.remaining)} still unread.`,
    ...(result.stoppedBecause === undefined
      ? []
      : [`Stopped early: ${result.stoppedBecause}. Everything read before it is kept.`]),
    ...(result.failures.length === 0
      ? []
      : [
          `Could not read: ${result.failures.map((failure) => `${failure.videoId} (${failure.code})`).join(', ')}`,
        ]),
    ...(result.remaining > 0 || result.stoppedBecause !== undefined
      ? ['', 'Call harvest_details again to continue with the next unread videos.']
      : []),
  ];

  return toolResult(lines.join('\n'), {
    channelId: result.channelId,
    name: result.name,
    attempted: result.attempted,
    stored: result.stored,
    failures: result.failures,
    remaining: result.remaining,
    ...(result.stoppedBecause === undefined ? {} : { stoppedBecause: result.stoppedBecause }),
    coverage: result.coverage,
  });
}
