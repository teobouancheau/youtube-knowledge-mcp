import type { BrainChunk } from '../brain-schemas.js';
import { isStopWord } from './search-index.js';

/**
 * Phrases a creator repeats across videos.
 *
 * This is the one statistic here that is not a plain count, so it is worth
 * saying what it does and does not claim. A phrase appearing in several
 * different videos is repeated; that is a fact about the corpus. Whether it is
 * a catchphrase, a verbal tic or a segment title is a judgement, and belongs to
 * whoever reads the list.
 *
 * Counting every 3-to-6-word window at once would hold millions of keys in
 * memory. Instead each length is counted only where the length below it
 * survived — a phrase cannot recur more often than its own prefix does — so all
 * but the first pass work on a small candidate set.
 */

export const PHRASE_MIN_WORDS = 3;
export const PHRASE_MAX_WORDS = 6;
/** Repetition inside one video is a habit of that video, not of the channel. */
export const PHRASE_MIN_VIDEOS = 3;
export const PHRASE_LIMIT = 20;

export interface RecurringPhrase {
  phrase: string;
  videoCount: number;
  occurrences: number;
}

interface Tally {
  occurrences: number;
  videoCount: number;
  /**
   * Distinct videos are counted by watching this change, which needs the corpus
   * grouped by video — see `wordsByVideo`. Holding a set of video ids per
   * phrase instead is what makes this pass expensive on a large channel.
   */
  lastVideoIndex: number;
}

export function findRecurringPhrases(chunks: BrainChunk[]): RecurringPhrase[] {
  const corpus = wordsByVideo(chunks);
  const kept: RecurringPhrase[] = [];
  let candidates = new Set<string>();

  for (let length = PHRASE_MIN_WORDS; length <= PHRASE_MAX_WORDS; length++) {
    const tallies = countPhrases(
      corpus,
      length,
      length === PHRASE_MIN_WORDS ? undefined : candidates
    );

    candidates = new Set();
    for (const [phrase, tally] of tallies) {
      if (tally.videoCount < PHRASE_MIN_VIDEOS) continue;
      candidates.add(phrase);
      kept.push({ phrase, videoCount: tally.videoCount, occurrences: tally.occurrences });
    }

    if (candidates.size === 0) break;
  }

  return rank(kept);
}

/**
 * The corpus as one word list per video, in a stable order.
 *
 * Grouping is what lets distinct-video counts be kept as a single field per
 * phrase rather than a set of video ids per phrase, which for a large channel
 * is the difference between tens of megabytes and hundreds.
 */
function wordsByVideo(chunks: BrainChunk[]): string[][] {
  const byVideo = new Map<string, string[]>();

  for (const chunk of chunks) {
    const words = byVideo.get(chunk.videoId) ?? [];
    words.push(...phraseWords(chunk.text));
    byVideo.set(chunk.videoId, words);
  }

  return [...byVideo.values()];
}

/** Lowercased words, apostrophes kept because "don't" is one word. */
function phraseWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

function countPhrases(
  corpus: string[][],
  length: number,
  candidatePrefixes: Set<string> | undefined
): Map<string, Tally> {
  const tallies = new Map<string, Tally>();

  for (const [videoIndex, words] of corpus.entries()) {
    for (let start = 0; start + length <= words.length; start++) {
      const window = words.slice(start, start + length);

      // A longer phrase only recurs where its prefix already did. A phrase
      // whose opening words are all filler is therefore never reached, which is
      // the intended trade: it costs "and then i went on" to drop "and then i".
      if (candidatePrefixes !== undefined) {
        if (!candidatePrefixes.has(window.slice(0, length - 1).join(' '))) continue;
      } else if (window.every(isStopWord)) {
        continue;
      }

      const phrase = window.join(' ');
      const tally = tallies.get(phrase);

      if (tally === undefined) {
        tallies.set(phrase, { occurrences: 1, videoCount: 1, lastVideoIndex: videoIndex });
        continue;
      }

      tally.occurrences++;
      if (tally.lastVideoIndex !== videoIndex) {
        tally.videoCount++;
        tally.lastVideoIndex = videoIndex;
      }
    }
  }

  return tallies;
}

/**
 * Drop the truncations, then order by reach.
 *
 * A phrase contained in a longer kept phrase that is just as widespread says
 * nothing the longer one does not — otherwise every long catchphrase drags in
 * three truncations of itself. Subsumption has to consider the longest first,
 * which is not the order worth reporting, so the two happen in separate passes.
 */
function rank(phrases: RecurringPhrase[]): RecurringPhrase[] {
  const longestFirst = [...phrases].sort(
    (a, b) => b.phrase.split(' ').length - a.phrase.split(' ').length || b.videoCount - a.videoCount
  );

  const distinct: RecurringPhrase[] = [];

  for (const candidate of longestFirst) {
    const subsumed = distinct.some(
      (existing) =>
        existing.phrase.includes(candidate.phrase) && existing.videoCount >= candidate.videoCount
    );
    if (!subsumed) distinct.push(candidate);
  }

  return distinct
    .sort((a, b) => b.videoCount - a.videoCount || b.occurrences - a.occurrences)
    .slice(0, PHRASE_LIMIT);
}
