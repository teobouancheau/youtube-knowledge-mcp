import type { DatabaseSync } from 'node:sqlite';
import type { CompletenessReason } from '../harvest-schemas.js';
import { YouTubeError, classifyPlayability, type YouTubeErrorCode } from './errors.js';
import { inTransaction } from './store.js';
import {
  READ_FAILED_AVAILABILITY,
  UNREADABLE_AVAILABILITY,
  type UnreadableAvailability,
  markUnreadable,
  saveVideoDetail,
} from './video-detail-store.js';
import { fetchVideoStatsRow } from './video-stats.js';

/** Reading one batch of videos and keeping what came back, a batch at a time. */

export interface DetailFailure {
  videoId: string;
  code: YouTubeErrorCode;
}

/** Refusals that say the next video will be refused too: stop rather than hammer. */
export const STOPPING: Partial<Record<YouTubeErrorCode, CompletenessReason>> = {
  BOT_CHECK: 'SOURCE_REFUSED',
  LOGIN_REQUIRED: 'SOURCE_REFUSED',
  RATE_LIMITED: 'RATE_LIMITED',
  CANCELLED: 'CANCELLED',
};

export type Read =
  | { videoId: string; row: Awaited<ReturnType<typeof fetchVideoStatsRow>> }
  | { videoId: string; code: YouTubeErrorCode };

export async function read(videoId: string): Promise<Read> {
  try {
    // Tolerant, so a private or members-only video comes back as a row whose
    // availability says so, not as a failure that asks to sign in and would be taken
    // for a problem with the whole session.
    const row = await fetchVideoStatsRow(videoId, { tolerateRefusal: true });
    const refusal = classifyPlayability({
      availability: row.availability ?? undefined,
      liveStatus: row.live_status ?? undefined,
    });
    return refusal === undefined ? { videoId, row } : { videoId, code: refusal.code };
  } catch (error) {
    return { videoId, code: error instanceof YouTubeError ? error.code : 'YTDLP_FAILED' };
  }
}

/** What to record for a video that failed, so it is not tried first on every run. */
function unreadableMarker(code: YouTubeErrorCode): UnreadableAvailability {
  return (
    Object.entries(UNREADABLE_AVAILABILITY).find(([key]) => key === code)?.[1] ??
    READ_FAILED_AVAILABILITY
  );
}

export function stoppingCode(batch: Read[]): YouTubeErrorCode | undefined {
  return batch
    .flatMap((outcome) => ('code' in outcome ? [outcome.code] : []))
    .find((code) => STOPPING[code] !== undefined);
}

export function persist(
  database: DatabaseSync,
  batch: Read[]
): { stored: number; failures: DetailFailure[] } {
  const failures: DetailFailure[] = [];
  let stored = 0;

  inTransaction(database, () => {
    for (const outcome of batch) {
      if ('row' in outcome) {
        saveVideoDetail(database, { ...outcome.row, id: outcome.videoId }, Date.now());
        stored += 1;
        continue;
      }
      failures.push({ videoId: outcome.videoId, code: outcome.code });
      // A refusal that will hit every video is a session problem: the run stops for it
      // below, and marking this video would blame it for something it did not do.
      if (STOPPING[outcome.code] === undefined) {
        markUnreadable(database, outcome.videoId, unreadableMarker(outcome.code));
      }
    }
  });

  return { stored, failures };
}
