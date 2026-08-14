import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { brainStatsSchema, type BrainStats } from '../brain-schemas.js';
import { buildBrain } from '../utils/brain-build.js';
import { withBuildLock } from '../utils/brain-lock.js';
import { readManifest } from '../utils/brain-storage.js';
import { toolResult } from '../utils/format.js';
import { assertChannelId } from '../utils/validate.js';
import { getChannelInfo, listVideos, type VideoListItem } from '../utils/youtube.js';

export const buildBrainSchema = {
  channel: z.string().describe('Channel URL, @handle, or name'),
  maxVideos: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe('How many of the most recent videos to consider. Default: 100'),
  since: z
    .string()
    .optional()
    .describe(
      'Only videos uploaded on or after this date (YYYY-MM-DD). Videos with no reported date are kept.'
    ),
  minDurationSeconds: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      'Skip anything shorter, to leave out shorts and clips. Videos of unknown length are skipped when this is set. Default: 0'
    ),
};

export const buildBrainOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  handle: z.string(),
  channelUrl: z.string(),
  considered: z.number().int().describe('Videos matching the filters'),
  processed: z.number().int().describe('Videos read during this call'),
  skipped: z.number().int().describe('Videos already in the brain'),
  stoppedEarly: z.boolean(),
  stopReason: z.string().optional(),
  stats: brainStatsSchema,
};

/**
 * Build or extend a channel brain.
 *
 * Idempotent by construction: it reads what is missing and leaves what is
 * already there, so calling it again after an interruption continues, and
 * calling it on a finished brain picks up new uploads. That is also why there
 * is no separate refresh tool.
 */
export async function buildBrainHandler({
  channel,
  maxVideos,
  since,
  minDurationSeconds,
}: {
  channel: string;
  maxVideos: number;
  since?: string;
  minDurationSeconds: number;
}): Promise<CallToolResult> {
  const info = await getChannelInfo(channel);
  assertChannelId(info.channelId);

  const listed = await listVideos(info.channelUrl, maxVideos);
  const videos = listed.filter((video) => matches(video, since, minDurationSeconds));

  const result = await withBuildLock(info.channelId, async () =>
    buildBrain({
      channel: info,
      videos,
      existing: await readManifest(info.channelId),
    })
  );

  return toolResult(render(info.name, videos.length, result), {
    channelId: info.channelId,
    name: info.name,
    handle: info.handle,
    channelUrl: info.channelUrl,
    considered: videos.length,
    processed: result.processed,
    skipped: result.skipped,
    stoppedEarly: result.stoppedEarly,
    ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
    stats: result.manifest.stats,
  });
}

/**
 * A video of unknown length is skipped only when a minimum was asked for:
 * without one, there is nothing to exclude it on. A video of unknown date is
 * kept either way, because "not proven old" is not "old".
 */
function matches(video: VideoListItem, since: string | undefined, minDuration: number): boolean {
  if (minDuration > 0 && video.duration < minDuration) return false;
  if (since !== undefined && video.uploadDate !== '' && video.uploadDate < since) return false;
  return true;
}

function render(
  name: string,
  considered: number,
  result: {
    processed: number;
    skipped: number;
    stopReason?: string;
    manifest: { stats: BrainStats };
  }
): string {
  const { stats } = result.manifest;

  const lines = [
    `Brain for ${name}: ${stats.indexedCount} of ${stats.videoCount} videos indexed, ${stats.chunkCount.toLocaleString()} passages.`,
    '',
    `Considered ${considered} videos · read ${result.processed} · already had ${result.skipped}`,
  ];

  if (stats.noCaptionsCount > 0) lines.push(`${stats.noCaptionsCount} have no captions`);
  if (stats.failedCount > 0) {
    lines.push(`${stats.failedCount} could not be read — call build_brain again to retry them`);
  }
  if (stats.pendingCount > 0) lines.push(`${stats.pendingCount} not read yet`);

  if (result.stopReason !== undefined) {
    lines.push('', `Stopped early: ${result.stopReason}`, 'Call build_brain again to continue.');
  }

  lines.push('', 'Ask it something with ask_brain.');
  return lines.join('\n');
}
