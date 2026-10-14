import type { DatabaseSync } from 'node:sqlite';
import type { Coverage } from '../harvest-schemas.js';
import { reportProgress, throwIfAborted } from './context.js';
import { coverageOf } from './coverage.js';
import { STOPPING, persist, read, stoppingCode, type DetailFailure } from './detail-batch.js';
import { YouTubeError, type YouTubeErrorCode } from './errors.js';
import { withChannelHarvestLock } from './harvest-lock.js';
import { readReceipt, saveReceipt } from './harvest-receipts.js';
import { inTransaction } from './store.js';
import { catalogCounts, pendingVideoIds, unreadableCount } from './video-detail-store.js';
import { getChannelInfo } from './youtube-channel.js';
import { concurrencyState } from './ytdlp.js';

/**
 * Reading every catalogued video of a channel, and keeping what each said.
 *
 * Resumable by construction: a video is read once, its row says so, and the next run
 * takes the next unread one. What came back before a refusal is kept, because every
 * batch commits on its own.
 */

export const DEFAULT_DETAIL_BATCH = 50;
export const MAX_DETAIL_BATCH = 500;
/** Concurrent reads. Each is a full yt-dlp extraction, the call YouTube throttles hardest. */
const READ_CONCURRENCY = 4;

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export interface DetailsResult {
  channelId: string;
  name: string;
  attempted: number;
  stored: number;
  failures: DetailFailure[];
  /** Videos still unread and still readable. */
  remaining: number;
  /** The error that made the run stop early, when one did. */
  stoppedBecause?: YouTubeErrorCode;
  coverage: Coverage;
}

export async function harvestDetails(
  database: DatabaseSync,
  channel: string,
  options: { maxVideos: number; retryUnreadable?: boolean }
): Promise<DetailsResult> {
  const info = await getChannelInfo(channel);

  if (catalogCounts(database, info.channelId).videos === 0) {
    throw new YouTubeError('NOT_FOUND', `${info.name} has not been catalogued yet.`, {
      nextStep: 'Call harvest_channel first, so there is a catalogue of videos to read.',
    });
  }

  return withChannelHarvestLock(info.channelId, async () => {
    const startedAt = Date.now();
    const { channelId } = info;
    const queue = pendingVideoIds(database, channelId, options.maxVideos, {
      includeUnreadable: options.retryUnreadable === true,
    });
    const width = Math.max(1, Math.min(concurrencyState().limit, READ_CONCURRENCY));

    const failures: DetailFailure[] = [];
    let stored = 0;
    let attempted = 0;
    let stoppedBecause: YouTubeErrorCode | undefined;

    for (let start = 0; start < queue.length && stoppedBecause === undefined; start += width) {
      throwIfAborted();
      reportProgress(start, queue.length, 'harvest_details');

      const batch = await Promise.all(queue.slice(start, start + width).map(read));
      attempted += batch.length;

      const saved = persist(database, batch);
      stored += saved.stored;
      failures.push(...saved.failures);
      stoppedBecause = stoppingCode(batch);
    }

    const counts = catalogCounts(database, channelId);
    const remaining = pendingVideoIds(database, channelId, counts.videos).length;
    const unreadable = unreadableCount(database, channelId);
    const capBound = attempted >= options.maxVideos && remaining > 0;

    const catalog = readReceipt(database, 'channel-catalog', channelId);
    const stopReason = stoppedBecause === undefined ? undefined : STOPPING[stoppedBecause];

    const coverage = coverageOf({
      scope: 'video-details',
      targetId: channelId,
      have: counts.detailed,
      source: 'yt-dlp -j per catalogued video',
      // The catalogue's size is a fair total only if the catalogue itself is whole.
      ...(catalog?.complete === true
        ? { expected: { value: counts.videos, source: 'store:catalog' as const } }
        : {}),
      ...(capBound ? { limitApplied: options.maxVideos } : {}),
      ...(stopReason !== undefined
        ? { reason: stopReason }
        : remaining === 0 && (failures.length > 0 || unreadable > 0)
          ? { reason: 'PARTIAL_ERROR' as const }
          : {}),
      ...(remaining > 0 || stoppedBecause !== undefined
        ? { resumeToken: `details:${channelId}` }
        : {}),
      ...(unreadable > 0
        ? {
            note: `${plural(unreadable, 'video')} cannot be read (private, members-only, age-gated, removed or failing), so this stays incomplete.`,
          }
        : {}),
    });

    inTransaction(database, () => {
      saveReceipt(database, coverage, { startedAt });
    });

    return {
      channelId,
      name: info.name,
      attempted,
      stored,
      failures,
      remaining,
      ...(stoppedBecause === undefined ? {} : { stoppedBecause }),
      coverage,
    };
  });
}
