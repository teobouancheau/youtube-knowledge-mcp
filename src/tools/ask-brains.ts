import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { brainPassageSchema, type BrainManifest } from '../brain-schemas.js';
import { interleaveByRank } from '../utils/brain-fusion.js';
import { searchBrain } from '../utils/brain-index.js';
import { resolveBrain } from '../utils/brain-lookup.js';
import { listManifests } from '../utils/brain-storage.js';
import { YouTubeError } from '../utils/errors.js';
import { toolResult } from '../utils/format.js';

/**
 * One question put to several creators at once.
 *
 * Each brain is searched on its own, because BM25 scores are only meaningful inside
 * the corpus that produced them, and the results are interleaved by rank. Every
 * passage names its channel, so an answer built from them can say who said what.
 */

const MAX_CHANNELS = 20;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export const askBrainsSchema = {
  query: z
    .string()
    .min(1)
    .describe('What to look for. Matched against the words actually spoken, not a summary of them'),
  channels: z
    .array(z.string().max(256))
    .max(MAX_CHANNELS)
    .optional()
    .describe(
      'Brains to search, each a channel URL, @handle or name. Default: every brain that has been built'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`How many passages to return in all. Default: ${DEFAULT_LIMIT}`),
};

const crossChannelPassageSchema = brainPassageSchema.extend({
  channelId: z.string(),
  channelName: z.string(),
});

export const askBrainsOutputSchema = {
  query: z.string(),
  brainsSearched: z.number().int(),
  searched: z
    .array(
      z.object({
        channelId: z.string(),
        name: z.string(),
        matches: z
          .number()
          .int()
          .describe('Passages in this brain that match, not the number returned'),
      })
    )
    .describe('Every brain that was searched, so a channel with no match is visible'),
  passages: z.array(crossChannelPassageSchema),
};

export interface AskBrainsArgs {
  query: string;
  channels?: string[];
  limit: number;
}

async function brainsToSearch(channels: string[] | undefined): Promise<BrainManifest[]> {
  if (channels === undefined || channels.length === 0) {
    const all = await listManifests();
    if (all.length === 0) {
      throw new YouTubeError('NOT_FOUND', 'No brain has been built yet.', {
        nextStep: 'Call build_brain with a channel URL or handle to build one.',
      });
    }
    return all;
  }

  const resolved = await Promise.all(channels.map((channel) => resolveBrain(channel)));
  return [...new Map(resolved.map((manifest) => [manifest.channel.channelId, manifest])).values()];
}

export async function askBrainsHandler(args: AskBrainsArgs): Promise<CallToolResult> {
  const { query, limit } = args;
  const manifests = await brainsToSearch(args.channels);

  const searches = await Promise.all(
    manifests.map(async (manifest) => ({
      manifest,
      results: await searchBrain(manifest.channel.channelId, query, limit),
    }))
  );

  const byId = new Map(searches.map(({ manifest }) => [manifest.channel.channelId, manifest]));
  const merged = interleaveByRank(
    searches.map(({ manifest, results }) => ({
      source: manifest.channel.channelId,
      items: results.passages,
    })),
    limit
  );

  const passages = merged.map(({ source, item }) => ({
    ...item,
    channelId: source,
    channelName: byId.get(source)?.channel.name ?? source,
  }));

  const searched = searches.map(({ manifest, results }) => ({
    channelId: manifest.channel.channelId,
    name: manifest.channel.name,
    matches: results.total,
  }));

  const structured = { query, brainsSearched: manifests.length, searched, passages };

  if (passages.length === 0) {
    const brains = manifests.length === 1 ? '1 brain' : `${String(manifests.length)} brains`;
    return toolResult(
      [
        `Nothing in ${brains} matches "${query}".`,
        '',
        'The words are matched as spoken, so try the phrasing a creator would use.',
      ].join('\n'),
      structured
    );
  }

  const lines = [
    `${String(passages.length)} passages across ${String(manifests.length)} brains for "${query}"`,
    '',
    ...passages.flatMap((passage, index) => [
      `${String(index + 1)}. ${passage.channelName} — ${passage.title} [${passage.startFormatted}]`,
      `   ${passage.text}`,
      `   ${passage.url}`,
    ]),
  ];

  return toolResult(lines.join('\n'), structured);
}
