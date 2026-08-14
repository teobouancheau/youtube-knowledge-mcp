import type { BrainChunk, BrainManifest, BrainVideoState } from '../brain-schemas.js';
import { readChunks, writeChunks } from './brain-index.js';
import { ingestVideo, pendingState } from './brain-ingest.js';
import { computeStats } from './brain-stats.js';
import { BRAIN_MANIFEST_VERSION, writeManifest } from './brain-storage.js';
import { reportProgress, throwIfAborted } from './context.js';
import type { ChannelInfo, VideoListItem } from './youtube.js';

/**
 * Reading a channel into a brain.
 *
 * The shape of this is dictated by how long it takes. Several hundred videos is
 * several hundred yt-dlp invocations, so a build is something that gets
 * interrupted: cancelled by the client, throttled by YouTube, or killed along
 * with the editor it was started from. Every choice below follows from that —
 * per-video state rather than one "built" flag, checkpoints rather than a
 * single write at the end, and a failed video costing only itself.
 *
 * Which is also why there is no separate refresh: a second build sees what it
 * already has, skips it, and reads whatever is new.
 */

/** Frequent enough that little work is lost, rare enough not to dominate. */
export const CHECKPOINT_EVERY_VIDEOS = 10;

/** Matches the yt-dlp limiter, which queues anything beyond it anyway. */
export const BUILD_CONCURRENCY = 3;

/** Past this many throttled videos in a row, YouTube means it. */
export const RATE_LIMIT_TOLERANCE = 3;

export interface BuildBrainOptions {
  channel: ChannelInfo;
  videos: VideoListItem[];
  existing: BrainManifest | undefined;
}

export interface BuildBrainResult {
  manifest: BrainManifest;
  /** Videos read during this call, as opposed to carried over from an earlier one. */
  processed: number;
  skipped: number;
  stoppedEarly: boolean;
  stopReason?: string;
}

export async function buildBrain(options: BuildBrainOptions): Promise<BuildBrainResult> {
  const { channel, videos, existing } = options;
  const createdAt = existing?.createdAt ?? new Date().toISOString();

  const states = new Map<string, BrainVideoState>(Object.entries(existing?.videos ?? {}));
  for (const video of videos) {
    if (!states.has(video.id)) states.set(video.id, pendingState(video));
  }

  const chunksByVideo = groupByVideo(await readChunks(channel.channelId));
  const outstanding = videos.filter((video) => isOutstanding(states.get(video.id)));

  const save = async (): Promise<BrainManifest> => {
    const passages = flatten(states, chunksByVideo);
    const manifest = toManifest(channel, states, passages, createdAt);

    await writeChunks(channel.channelId, passages);
    await writeManifest(manifest);
    return manifest;
  };

  let processed = 0;
  let consecutiveThrottles = 0;
  let stopReason: string | undefined;

  await inBatches(outstanding, BUILD_CONCURRENCY, async (video) => {
    if (stopReason !== undefined) return;
    throwIfAborted();

    const { state, chunks } = await ingestVideo(video, countChunks(chunksByVideo));

    states.set(video.id, state);
    if (chunks.length > 0) chunksByVideo.set(video.id, chunks);
    else chunksByVideo.delete(video.id);

    processed++;
    consecutiveThrottles = state.error === 'RATE_LIMITED' ? consecutiveThrottles + 1 : 0;
    if (consecutiveThrottles >= RATE_LIMIT_TOLERANCE) {
      stopReason = 'YouTube is rate limiting this client.';
    }

    reportProgress(processed, outstanding.length, `Read ${processed} of ${outstanding.length}`);
    if (processed % CHECKPOINT_EVERY_VIDEOS === 0) await save();
  });

  return {
    manifest: await save(),
    processed,
    skipped: videos.length - outstanding.length,
    stoppedEarly: stopReason !== undefined,
    ...(stopReason === undefined ? {} : { stopReason }),
  };
}

/** Anything not already read: never attempted, or attempted and failed. */
function isOutstanding(state: BrainVideoState | undefined): boolean {
  return state === undefined || state.state === 'pending' || state.state === 'failed';
}

function groupByVideo(chunks: BrainChunk[]): Map<string, BrainChunk[]> {
  const grouped = new Map<string, BrainChunk[]>();

  for (const chunk of chunks) {
    grouped.set(chunk.videoId, [...(grouped.get(chunk.videoId) ?? []), chunk]);
  }

  return grouped;
}

function countChunks(chunksByVideo: Map<string, BrainChunk[]>): number {
  let total = 0;
  for (const chunks of chunksByVideo.values()) total += chunks.length;
  return total;
}

/** In manifest order, so the file changes as little as possible between builds. */
function flatten(
  states: Map<string, BrainVideoState>,
  chunksByVideo: Map<string, BrainChunk[]>
): BrainChunk[] {
  return [...states.keys()].flatMap((videoId) => chunksByVideo.get(videoId) ?? []);
}

function toManifest(
  channel: ChannelInfo,
  states: Map<string, BrainVideoState>,
  passages: BrainChunk[],
  createdAt: string
): BrainManifest {
  return {
    version: BRAIN_MANIFEST_VERSION,
    channel,
    createdAt,
    updatedAt: new Date().toISOString(),
    videos: Object.fromEntries(states),
    stats: computeStats([...states.values()], passages),
  };
}

/**
 * Run `work` over the items, `size` at a time.
 *
 * Deliberately not a rolling window: a batch boundary is a natural place for
 * the checkpoint and the cancellation check, and the limiter inside yt-dlp is
 * what actually paces the network.
 */
async function inBatches<T>(
  items: T[],
  size: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(work));
  }
}
