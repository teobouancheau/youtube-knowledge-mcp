import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { brainStatsSchema, type BrainStats } from '../brain-schemas.js';
import { buildBrain } from '../utils/brain-build.js';
import { withBuildLock } from '../utils/brain-lock.js';
import { readManifest } from '../utils/brain-storage.js';
import { toolResult } from '../utils/format.js';
import { assertChannelId, assertLanguageTag } from '../utils/validate.js';
import { getChannelInfo, listVideos, type VideoListItem } from '../utils/youtube.js';

export const buildBrainSchema = {
  channel: z.string().max(256).describe('Channel URL, @handle, or name'),
  maxVideos: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe('How many of the most recent videos to consider. Default: 100'),
  language: z
    .string()
    .default('en')
    .describe(
      'Caption language to read. A brain holds one language; build a separate one to read another. Default: en'
    ),
  since: z
    .string()
    .optional()
    .describe(
      "Only videos published on or after this date (YYYY-MM-DD), read from each video's own metadata rather than guessed at. Re-applied on every call, so narrowing or widening it takes effect without a rebuild."
    ),
  minDurationSeconds: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      'Skip anything shorter, to leave out shorts and clips. Re-applied on every call, like since. Default: 0'
    ),
};

export const buildBrainOutputSchema = {
  channelId: z.string(),
  name: z.string(),
  handle: z.string(),
  channelUrl: z.string(),
  language: z.string(),
  considered: z.number().int().describe('Videos the filters kept'),
  processed: z.number().int().describe('Videos read during this call'),
  skipped: z.number().int().describe('Videos already in the brain'),
  excluded: z.number().int().describe('Videos ruled out by since or minDurationSeconds'),
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
 *
 * The filters describe the brain rather than just this call, so a build makes
 * the brain match them: narrowing one discards the passages of videos it now
 * excludes, and widening it reads them again.
 */
export async function buildBrainHandler({
  channel,
  maxVideos,
  language,
  since,
  minDurationSeconds,
}: {
  channel: string;
  maxVideos: number;
  language: string;
  since?: string;
  minDurationSeconds: number;
}): Promise<CallToolResult> {
  assertLanguageTag(language);

  const info = await getChannelInfo(channel);
  assertChannelId(info.channelId);

  const result = await withBuildLock(info.channelId, async () =>
    buildBrain({
      channel: info,
      videos: await listUploads(info.channelUrl, maxVideos),
      existing: await readManifest(info.channelId),
      language,
      minDurationSeconds,
      ...(since === undefined ? {} : { since }),
    })
  );

  return toolResult(render(info.name, result), {
    channelId: info.channelId,
    name: info.name,
    handle: info.handle,
    channelUrl: info.channelUrl,
    language,
    considered: result.considered,
    processed: result.processed,
    skipped: result.skipped,
    excluded: result.excluded,
    stoppedEarly: result.stoppedEarly,
    ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
    stats: result.manifest.stats,
  });
}

/**
 * The channel's uploads, newest first.
 *
 * Deliberately the uploads tab rather than the channel itself. A bare channel
 * URL expands to every tab it has — shorts, live, releases — so `--playlist-end`
 * applies per tab and asking for two videos can return eight, from four
 * different places. The slice is belt and braces for a channel whose tabs
 * yt-dlp expands anyway.
 */
async function listUploads(channelUrl: string, maxVideos: number): Promise<VideoListItem[]> {
  const uploads = `${channelUrl.replace(/\/+$/, '')}/videos`;

  // No fallback to the bare channel URL. Every channel has an uploads tab, so a
  // failure here is a failure worth reporting — throttling, a network fault, a
  // channel that no longer exists — and retrying it against a URL that expands
  // to more work would double the load while reporting the wrong cause.
  return (await listVideos(uploads, maxVideos)).slice(0, maxVideos);
}

function render(
  name: string,
  result: {
    considered: number;
    processed: number;
    skipped: number;
    excluded: number;
    stopReason?: string;
    manifest: { stats: BrainStats };
  }
): string {
  const { stats } = result.manifest;

  const lines = [
    `Brain for ${name}: ${stats.indexedCount} of ${stats.videoCount} videos indexed, ${stats.chunkCount.toLocaleString()} passages.`,
    '',
    `Considered ${result.considered} videos · read ${result.processed} · already had ${result.skipped}${
      result.excluded > 0 ? ` · ${result.excluded} outside the filters` : ''
    }`,
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
