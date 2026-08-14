import type { BrainChunk, BrainStats, BrainVideoState } from '../brain-schemas.js';
import { findRecurringPhrases } from './brain-phrases.js';

/**
 * What the server can say about a channel without inferring anything.
 *
 * Everything here is counted or measured from the corpus. Deliberately absent:
 * named entities, because auto-generated captions arrive lowercase and
 * unpunctuated so capitalisation heuristics produce noise; and distinctive
 * vocabulary by TF-IDF, because there is no honest background corpus to compare
 * a channel against and inventing one would produce confident nonsense.
 *
 * Anything the numbers cannot support belongs in the profile, which a model
 * writes from passages it can cite.
 */

export function computeStats(videos: BrainVideoState[], chunks: BrainChunk[]): BrainStats {
  const uploadDates = videos
    .map((video) => video.uploadDate)
    .filter(Boolean)
    .sort();

  return {
    videoCount: videos.length,
    indexedCount: countState(videos, 'indexed'),
    noCaptionsCount: countState(videos, 'no-captions'),
    failedCount: countState(videos, 'failed'),
    pendingCount: countState(videos, 'pending'),
    chunkCount: chunks.length,
    totalWords: videos.reduce((total, video) => total + video.wordCount, 0),
    medianWordsPerMinute: medianWordsPerMinute(videos),
    ...firstAndLast(uploadDates),
    uploadsPerMonth: uploadsPerMonth(uploadDates),
    recurringPhrases: findRecurringPhrases(chunks),
  };
}

function countState(videos: BrainVideoState[], state: BrainVideoState['state']): number {
  return videos.filter((video) => video.state === state).length;
}

/**
 * The median rather than the mean: one mis-timed transcript, or a ten-hour
 * ambience upload with forty words in it, would drag an average anywhere.
 */
function medianWordsPerMinute(videos: BrainVideoState[]): number {
  const rates = videos
    .filter((video) => video.durationSeconds > 0 && video.wordCount > 0)
    .map((video) => (video.wordCount / video.durationSeconds) * 60)
    .sort((a, b) => a - b);

  if (rates.length === 0) return 0;

  const middle = Math.floor(rates.length / 2);
  const median =
    rates.length % 2 === 0
      ? ((rates[middle - 1] ?? 0) + (rates[middle] ?? 0)) / 2
      : (rates[middle] ?? 0);

  return Math.round(median);
}

function firstAndLast(sortedDates: string[]): { firstUpload?: string; lastUpload?: string } {
  const first = sortedDates[0];
  const last = sortedDates[sortedDates.length - 1];

  return {
    ...(first === undefined ? {} : { firstUpload: first }),
    ...(last === undefined ? {} : { lastUpload: last }),
  };
}

/** Months with no uploads are absent rather than zero: this is a tally, not a series. */
function uploadsPerMonth(sortedDates: string[]): { month: string; videos: number }[] {
  const months = new Map<string, number>();

  for (const date of sortedDates) {
    const month = date.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + 1);
  }

  return [...months.entries()].map(([month, videos]) => ({ month, videos }));
}
