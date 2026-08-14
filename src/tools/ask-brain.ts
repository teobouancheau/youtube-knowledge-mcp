import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { brainPassageSchema, type BrainPassage } from '../brain-schemas.js';
import { searchBrain } from '../utils/brain-index.js';
import { resolveBrain } from '../utils/brain-lookup.js';
import { pageInfo, toolResult } from '../utils/format.js';
import { paginationShape } from '../schemas.js';

export const askBrainSchema = {
  channel: z.string().describe('Channel URL, @handle, or name of a brain built with build_brain'),
  query: z
    .string()
    .min(1)
    .describe('What to look for. Matched against the words actually spoken, not a summary of them'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(8)
    .describe('How many passages to return. Default: 8'),
};

export const askBrainOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  query: z.string(),
  passages: z.array(brainPassageSchema),
  ...paginationShape,
};

/**
 * Search a brain and return the moments that answer the query.
 *
 * This is the only route from a corpus into a model's context: a few hundred
 * videos is tens of megabytes of transcript, and no tool here will hand that
 * over. Every passage comes back with the second it was said and a link that
 * opens the video there, so an answer built from these can be checked rather
 * than trusted.
 */
export async function askBrainHandler({
  channel,
  query,
  limit,
}: {
  channel: string;
  query: string;
  limit: number;
}): Promise<CallToolResult> {
  const manifest = await resolveBrain(channel);
  const { channelId, name } = manifest.channel;
  const passages = await searchBrain(channelId, query, limit);

  return toolResult(render(name, query, passages), {
    channelId,
    name,
    query,
    passages,
    ...pageInfo(passages.length, passages.length),
  });
}

function render(name: string, query: string, passages: BrainPassage[]): string {
  if (passages.length === 0) {
    return [
      `Nothing in ${name}'s brain matches "${query}".`,
      '',
      'The words are matched as spoken, so try the phrasing the creator would use.',
      'Call get_brain_info to see how much of the channel is actually indexed.',
    ].join('\n');
  }

  const sections = passages.map((passage) =>
    [`### ${passage.title} [${passage.startFormatted}]`, passage.url, '', passage.text].join('\n')
  );

  return [`${passages.length} passages from ${name} matching "${query}"`, '', ...sections].join(
    '\n\n'
  );
}
