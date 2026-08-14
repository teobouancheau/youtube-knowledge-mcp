import type { BrainChunk, BrainManifest, BrainVideoState } from '../brain-schemas.js';
import { readChunks, writeChunks } from './brain-index.js';
import { ingestVideo, pendingState, uploadDateOf } from './brain-ingest.js';
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
  /** Caption language to read. A brain is built from one language at a time. */
  language: string;
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
  const { channel, videos, existing, language } = options;
  const createdAt = existing?.createdAt ?? new Date().toISOString();

  const chunksByVideo = groupByVideo(await readChunks(channel.channelId));
  const states = reconciled(existing, videos, chunksByVideo);
  const outstanding = videos.filter((video) => isOutstanding(states.get(video.id)));

  const save = async (): Promise<BrainManifest> => {
    const passages = flatten(states, chunksByVideo);
    const manifest = toManifest(channel, states, passages, createdAt, language);

    await writeChunks(channel.channelId, passages);
    await writeManifest(manifest);
    return manifest;
  };

  let processed = 0;
  let consecutiveThrottles = 0;
  let stopReason: string | undefined;

  try {
    await inBatches(outstanding, BUILD_CONCURRENCY, async (video) => {
      if (stopReason !== undefined) return;
      throwIfAborted();

      const { state, chunks } = await ingestVideo(video, countChunks(chunksByVideo), language);

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
  } catch (error) {
    // A cancelled build must not throw away the videos read since the last
    // checkpoint. Saving first is what makes "interrupt it and call it again"
    // true rather than nearly true.
    await save();
    throw error;
  }

  return {
    manifest: await save(),
    processed,
    skipped: videos.length - outstanding.length,
    stoppedEarly: stopReason !== undefined,
    ...(stopReason === undefined ? {} : { stopReason }),
  };
}

/**
 * Per-video state, corrected against the passages actually on disk.
 *
 * The manifest and the passage file are two documents, and only one of them can
 * be written first. A crash between the two, a half-restored backup, or a
 * `chunks.json` truncated by a full disk all end the same way: the manifest says
 * a video was read and there is nothing to show for it. Left alone that brain is
 * stranded for good — every build skips the video as already done, while every
 * search returns nothing.
 *
 * So the passages win. A video the corpus cannot account for goes back to
 * pending and is read again on this very call, which is why there is no repair
 * tool to remember to run.
 */
function reconciled(
  existing: BrainManifest | undefined,
  videos: VideoListItem[],
  chunksByVideo: Map<string, BrainChunk[]>
): Map<string, BrainVideoState> {
  const states = new Map<string, BrainVideoState>();

  for (const [videoId, state] of Object.entries(existing?.videos ?? {})) {
    const lost = state.state === 'indexed' && (chunksByVideo.get(videoId)?.length ?? 0) === 0;
    states.set(videoId, lost ? { ...state, state: 'pending', chunkCount: 0, wordCount: 0 } : state);
  }

  for (const video of videos) {
    if (!states.has(video.id)) states.set(video.id, pendingState(video));
  }

  return states;
}

/**
 * The same videos, with the dates a flat listing does not carry.
 *
 * Only worth doing when a caller asked to filter by date, because it costs one
 * metadata request per candidate. Dates already recorded by an earlier build
 * are reused, so a channel is not re-dated every time.
 */
export async function datedVideos(
  videos: VideoListItem[],
  existing: BrainManifest | undefined
): Promise<VideoListItem[]> {
  const dated: VideoListItem[] = [];

  await inBatches(videos, BUILD_CONCURRENCY, async (video) => {
    throwIfAborted();
    const known = existing?.videos[video.id]?.uploadDate;

    dated.push({
      ...video,
      uploadDate: known !== undefined && known !== '' ? known : await uploadDateOf(video),
    });
  });

  // `inBatches` finishes a batch before starting the next, but within one batch
  // completion order is not arrival order.
  const order = new Map(videos.map((video, index) => [video.id, index]));
  return dated.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
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
  createdAt: string,
  language: string
): BrainManifest {
  return {
    version: BRAIN_MANIFEST_VERSION,
    channel,
    language,
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
