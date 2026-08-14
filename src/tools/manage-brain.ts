import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveBrain } from '../utils/brain-lookup.js';
import { deleteBrain, writeProfile } from '../utils/brain-storage.js';
import { fileResult, toolResult } from '../utils/format.js';

/**
 * The two things that change a brain without reading YouTube: keeping the
 * written account of a creator, and throwing the whole brain away.
 */

// -- save_brain_profile --------------------------------------------------

export const saveBrainProfileSchema = {
  channel: z.string().describe('Channel URL, @handle, name, or channel id of an existing brain'),
  content: z
    .string()
    .min(1)
    .describe(
      'The profile, as markdown. Ground every claim in passages from ask_brain and cite them with [MM:SS] and a link, so a reader can check it against the video.'
    ),
};

export const saveBrainProfileOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  path: z.string(),
  characters: z.number().int(),
};

/**
 * Store the written account of a creator.
 *
 * The server cannot write this: it has no language model, and a profile is a
 * reading of the corpus rather than a measurement of it. What it can do is keep
 * the reading beside the passages it came from, and refuse to invent one.
 */
export async function saveBrainProfileHandler({
  channel,
  content,
}: {
  channel: string;
  content: string;
}): Promise<CallToolResult> {
  const manifest = await resolveBrain(channel);
  const { channelId, name } = manifest.channel;
  const path = await writeProfile(channelId, content);

  return fileResult(
    `Saved a profile for ${name} (${content.length.toLocaleString()} characters).`,
    { channelId, name, path, characters: content.length },
    { path, name: `${name} profile`, mimeType: 'text/markdown' }
  );
}

// -- delete_brain --------------------------------------------------------

export const deleteBrainSchema = {
  channel: z.string().describe('Channel URL, @handle, name, or channel id of an existing brain'),
};

export const deleteBrainOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  deleted: z.boolean(),
};

export async function deleteBrainHandler({
  channel,
}: {
  channel: string;
}): Promise<CallToolResult> {
  const manifest = await resolveBrain(channel);
  const { channelId, name } = manifest.channel;
  const deleted = await deleteBrain(channelId);

  return toolResult(
    deleted
      ? `Deleted the brain for ${name}. The transcripts it was built from are still cached, so rebuilding is fast.`
      : `There was nothing left to delete for ${name}.`,
    { channelId, name, deleted }
  );
}
