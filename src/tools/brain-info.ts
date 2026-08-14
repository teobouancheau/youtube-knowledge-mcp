import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  brainStatsSchema,
  brainSummarySchema,
  brainVideoStateSchema,
  type BrainManifest,
} from '../brain-schemas.js';
import { resolveBrain } from '../utils/brain-lookup.js';
import { hasProfile, listManifests } from '../utils/brain-storage.js';
import { pageInfo, toolResult } from '../utils/format.js';
import { paginationShape } from '../schemas.js';

/**
 * Reading what a brain covers: which channels have one, and how much of each
 * channel it actually reached.
 */

// -- list_brains ---------------------------------------------------------

export const listBrainsSchema = {};

export const listBrainsOutputSchema = {
  brains: z.array(brainSummarySchema),
  ...paginationShape,
};

export async function listBrainsHandler(): Promise<CallToolResult> {
  const manifests = await listManifests();
  const brains = manifests.map(summarize);

  const lines =
    brains.length === 0
      ? ['No brains have been built yet.', '', 'Call build_brain with a channel URL or handle.']
      : brains.map(
          (brain) =>
            `${brain.name} (${brain.handle || brain.channelId}) — ${brain.indexedCount}/${brain.videoCount} videos, ${brain.chunkCount.toLocaleString()} passages, updated ${brain.updatedAt.slice(0, 10)}${brain.hasProfile ? ', has a profile' : ''}`
        );

  return toolResult(lines.join('\n'), {
    brains,
    ...pageInfo(brains.length, brains.length),
  });
}

function summarize(manifest: BrainManifest): z.infer<typeof brainSummarySchema> {
  const { channelId, name, handle, channelUrl } = manifest.channel;

  return {
    channelId,
    name,
    handle,
    channelUrl,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    hasProfile: hasProfile(channelId),
    videoCount: manifest.stats.videoCount,
    indexedCount: manifest.stats.indexedCount,
    chunkCount: manifest.stats.chunkCount,
  };
}

// -- get_brain_info ------------------------------------------------------

export const getBrainInfoSchema = {
  channel: z.string().describe('Channel URL, @handle, name, or channel id of an existing brain'),
  includeVideos: z
    .boolean()
    .default(false)
    .describe('List every video and its state. Long for a large channel. Default: false'),
};

export const getBrainInfoOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  handle: z.string(),
  channelUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hasProfile: z.boolean(),
  stats: brainStatsSchema,
  videos: z.array(brainVideoStateSchema).optional(),
};

export async function getBrainInfoHandler({
  channel,
  includeVideos,
}: {
  channel: string;
  includeVideos: boolean;
}): Promise<CallToolResult> {
  const manifest = await resolveBrain(channel);
  const { channelId, name, handle, channelUrl } = manifest.channel;
  const { stats } = manifest;
  const videos = Object.values(manifest.videos);

  const lines = [
    `${name} (${handle || channelId})`,
    `${stats.indexedCount} of ${stats.videoCount} videos indexed · ${stats.chunkCount.toLocaleString()} passages · ${stats.totalWords.toLocaleString()} words`,
    `${stats.medianWordsPerMinute} words per minute (median)`,
    stats.firstUpload === undefined
      ? 'No upload dates reported'
      : `Uploads from ${stats.firstUpload} to ${stats.lastUpload ?? stats.firstUpload}`,
    `Updated ${manifest.updatedAt}`,
  ];

  if (stats.noCaptionsCount > 0) lines.push(`${stats.noCaptionsCount} videos have no captions`);
  if (stats.failedCount + stats.pendingCount > 0) {
    lines.push(
      `${stats.failedCount + stats.pendingCount} videos still to read — call build_brain to continue`
    );
  }

  if (stats.recurringPhrases.length > 0) {
    lines.push(
      '',
      'Phrases repeated across videos:',
      ...stats.recurringPhrases.map(
        (entry) => `  "${entry.phrase}" — ${entry.videoCount} videos, ${entry.occurrences} times`
      )
    );
  }

  if (includeVideos) {
    lines.push(
      '',
      ...videos.map(
        (video) =>
          `${video.state.padEnd(12)} ${video.uploadDate || '          '} ${video.title}${video.error === undefined ? '' : ` (${video.error})`}`
      )
    );
  }

  return toolResult(lines.join('\n'), {
    channelId,
    name,
    handle,
    channelUrl,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    hasProfile: hasProfile(channelId),
    stats,
    ...(includeVideos ? { videos } : {}),
  });
}
