import type { BrainChunk, BrainManifest, BrainVideoState } from '../brain-schemas.js';
import { readChunks, writeChunks } from './brain-index.js';
import {
  excluded,
  ingestVideo,
  isExcluded,
  pendingState,
  type VideoFilters,
} from './brain-ingest.js';
import { computeStats } from './brain-stats.js';
import { BRAIN_MANIFEST_VERSION, writeManifest } from './brain-storage.js';
import { reportProgress, throwIfAborted } from './context.js';
import { concurrencyState } from './ytdlp.js';
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

/**
 * How many videos to read at once: whatever the yt-dlp limiter is actually set
 * to, which `YOUTUBE_MCP_MAX_CONCURRENCY` can change.
 *
 * Read rather than copied. A second number that merely happened to match would
 * stop matching the moment someone tuned the first, and would then either queue
 * work behind a limit it could not see or batch below one it was allowed.
 */
function buildConcurrency(): number {
  return concurrencyState().limit;
}

/** Past this many throttled videos in a row, YouTube means it. */
export const RATE_LIMIT_TOLERANCE = 3;

export interface BuildBrainOptions extends VideoFilters {
  channel: ChannelInfo;
  videos: VideoListItem[];
  existing: BrainManifest | undefined;
  /** Caption language to read. A brain is built from one language at a time. */
  language: string;
}

export interface BuildBrainResult {
  manifest: BrainManifest;
  /** Videos the filters kept, whether or not this call had to read them. */
  considered: number;
  /** Videos read during this call, as opposed to carried over from an earlier one. */
  processed: number;
  skipped: number;
  excluded: number;
  stoppedEarly: boolean;
  stopReason?: string;
}

export async function buildBrain(options: BuildBrainOptions): Promise<BuildBrainResult> {
  const { channel, videos, existing, language, since, minDurationSeconds } = options;
  const filters: VideoFilters = { minDurationSeconds, ...(since === undefined ? {} : { since }) };
  const createdAt = existing?.createdAt ?? new Date().toISOString();

  const chunksByVideo = groupByVideo(await readChunks(channel.channelId));
  const states = reconciled(existing, videos, chunksByVideo, filters);
  const outstanding = videos.filter((video) => isOutstanding(states.get(video.id)));

  /**
   * `phrases` is the difference between a checkpoint and the end of a build:
   * the phrase pass reads the whole corpus and takes seconds at the sizes a
   * brain can reach, so it runs once, when there is a finished corpus to run it
   * over. A checkpoint records what has been read, which is all it is for.
   */
  const save = async (phrases: boolean): Promise<BrainManifest> => {
    const passages = flatten(states, chunksByVideo);
    const manifest = toManifest(channel, states, passages, createdAt, language, phrases);

    await writeChunks(channel.channelId, passages);
    await writeManifest(manifest);
    return manifest;
  };

  let attempted = 0;
  let processed = 0;
  let consecutiveThrottles = 0;
  let stopReason: string | undefined;

  try {
    await inBatches(outstanding, buildConcurrency(), async (video) => {
      if (stopReason !== undefined) return;
      throwIfAborted();

      const { state, chunks } = await ingestVideo(video, countChunks(chunksByVideo), {
        language,
        ...filters,
      });

      states.set(video.id, state);
      if (chunks.length > 0) chunksByVideo.set(video.id, chunks);
      else chunksByVideo.delete(video.id);

      attempted++;
      // A video the filters ruled out was looked at, not read.
      if (state.state !== 'excluded') processed++;

      consecutiveThrottles = state.error === 'RATE_LIMITED' ? consecutiveThrottles + 1 : 0;
      if (consecutiveThrottles >= RATE_LIMIT_TOLERANCE) {
        stopReason = 'YouTube is rate limiting this client.';
      }

      reportProgress(attempted, outstanding.length, `Read ${attempted} of ${outstanding.length}`);
      if (attempted % CHECKPOINT_EVERY_VIDEOS === 0) await save(false);
    });
  } catch (error) {
    // A cancelled build must not throw away the videos read since the last
    // checkpoint. Saving first is what makes "interrupt it and call it again"
    // true rather than nearly true — and it is a checkpoint, not a finished
    // corpus, so it does not pay for the phrase pass either.
    await save(false);
    throw error;
  }

  const manifest = await save(true);
  const excludedCount = videos.filter((video) => states.get(video.id)?.state === 'excluded').length;

  return {
    manifest,
    considered: videos.length - excludedCount,
    processed,
    skipped: videos.length - excludedCount - processed,
    excluded: excludedCount,
    stoppedEarly: stopReason !== undefined,
    ...(stopReason === undefined ? {} : { stopReason }),
  };
}

/**
 * Per-video state, reconciled against the passages on disk and re-tested
 * against the filters in force right now.
 *
 * Two corrections happen here, both for the same reason: what the manifest says
 * was true when it was written, and neither the corpus nor the caller's filters
 * are obliged to have stayed the same.
 *
 * The manifest and the passage file are two documents, and only one can be
 * written first. A crash between them, a half-restored backup, or a
 * `chunks.json` truncated by a full disk all end the same way — the manifest
 * says a video was read and there is nothing to show for it. Left alone that
 * brain is stranded for good: every build skips the video as already done while
 * every search returns nothing. So the passages win, and a video the corpus
 * cannot account for goes back to pending.
 *
 * A filter is re-applied rather than remembered. Narrowing one excludes videos
 * already read; widening one brings excluded videos back. Both are decided from
 * the dates and lengths already recorded, so changing your mind costs nothing
 * until there is something new to fetch.
 */
function reconciled(
  existing: BrainManifest | undefined,
  videos: VideoListItem[],
  chunksByVideo: Map<string, BrainChunk[]>,
  filters: VideoFilters
): Map<string, BrainVideoState> {
  const states = new Map<string, BrainVideoState>();

  for (const [videoId, recorded] of Object.entries(existing?.videos ?? {})) {
    const lost = recorded.state === 'indexed' && (chunksByVideo.get(videoId)?.length ?? 0) === 0;
    const state = lost
      ? { ...recorded, state: 'pending' as const, chunkCount: 0, wordCount: 0 }
      : recorded;

    states.set(videoId, refiltered(state, filters));
  }

  for (const video of videos) {
    // The listing's own length is real data, so a filter that can be decided
    // from it is decided here — before spending a request to learn what the
    // listing already said.
    if (!states.has(video.id)) states.set(video.id, refiltered(pendingState(video), filters));
  }

  return states;
}

/**
 * `undefined` — the filters cannot be decided from what is recorded — leaves the
 * state alone, so the video is read and the question answered from the metadata
 * that read fetches.
 */
function refiltered(state: BrainVideoState, filters: VideoFilters): BrainVideoState {
  const ruledOut = isExcluded(state, filters);

  if (ruledOut === true) return excluded(state);
  if (ruledOut === false && state.state === 'excluded') {
    return { ...state, state: 'pending' };
  }
  return state;
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

/**
 * The corpus: every passage of every video the brain holds, in manifest order so
 * the file changes as little as possible between builds.
 *
 * A video the filters exclude contributes nothing, which is what makes the
 * filters mean something. Leaving its passages in would let `ask_brain` quote a
 * video that `get_brain_info` says is not part of this brain, and no wording
 * makes that defensible.
 */
function flatten(
  states: Map<string, BrainVideoState>,
  chunksByVideo: Map<string, BrainChunk[]>
): BrainChunk[] {
  return [...states.entries()].flatMap(([videoId, state]) =>
    state.state === 'excluded' ? [] : (chunksByVideo.get(videoId) ?? [])
  );
}

function toManifest(
  channel: ChannelInfo,
  states: Map<string, BrainVideoState>,
  passages: BrainChunk[],
  createdAt: string,
  language: string,
  phrases: boolean
): BrainManifest {
  return {
    version: BRAIN_MANIFEST_VERSION,
    channel,
    language,
    createdAt,
    updatedAt: new Date().toISOString(),
    videos: Object.fromEntries(states),
    stats: computeStats([...states.values()], passages, { phrases }),
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
