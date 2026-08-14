import { describe, it, expect } from 'vitest';
import type { BrainChunk, BrainVideoState } from '../../src/brain-schemas.js';
import { computeStats } from '../../src/utils/brain-stats.js';
import { PHRASE_MIN_VIDEOS, findRecurringPhrases } from '../../src/utils/brain-phrases.js';

function video(overrides: Partial<BrainVideoState> = {}): BrainVideoState {
  return {
    videoId: 'v1',
    title: 'A video',
    url: 'https://www.youtube.com/watch?v=v1',
    uploadDate: '2025-01-15',
    durationSeconds: 600,
    state: 'indexed',
    chunkCount: 2,
    wordCount: 1500,
    ...overrides,
  };
}

function chunk(videoId: string, text: string, ordinal = 0): BrainChunk {
  return {
    id: `${videoId}:${ordinal}`,
    videoId,
    title: 'A video',
    startSeconds: ordinal * 30,
    endSeconds: ordinal * 30 + 30,
    text,
  };
}

describe('computeStats', () => {
  it('counts every state separately', () => {
    const stats = computeStats(
      [
        video({ videoId: 'a', state: 'indexed' }),
        video({ videoId: 'b', state: 'no-captions' }),
        video({ videoId: 'c', state: 'failed' }),
        video({ videoId: 'd', state: 'pending' }),
      ],
      []
    );

    expect(stats).toMatchObject({
      videoCount: 4,
      indexedCount: 1,
      noCaptionsCount: 1,
      failedCount: 1,
      pendingCount: 1,
    });
  });

  it('reports zero words per minute when nothing has been read yet', () => {
    const stats = computeStats([video({ state: 'pending', wordCount: 0 })], []);

    expect(stats.medianWordsPerMinute).toBe(0);
  });

  it('takes the median so one mistimed video cannot move the figure', () => {
    const stats = computeStats(
      [
        video({ videoId: 'a', durationSeconds: 600, wordCount: 1500 }),
        video({ videoId: 'b', durationSeconds: 600, wordCount: 1500 }),
        video({ videoId: 'c', durationSeconds: 1, wordCount: 4000 }),
      ],
      []
    );

    expect(stats.medianWordsPerMinute).toBe(150);
  });

  it('averages the two middle values for an even count', () => {
    const stats = computeStats(
      [
        video({ videoId: 'a', durationSeconds: 60, wordCount: 100 }),
        video({ videoId: 'b', durationSeconds: 60, wordCount: 200 }),
      ],
      []
    );

    expect(stats.medianWordsPerMinute).toBe(150);
  });

  it('reports the upload range and monthly tally', () => {
    const stats = computeStats(
      [
        video({ videoId: 'a', uploadDate: '2024-03-02' }),
        video({ videoId: 'b', uploadDate: '2024-03-20' }),
        video({ videoId: 'c', uploadDate: '2025-01-15' }),
      ],
      []
    );

    expect(stats.firstUpload).toBe('2024-03-02');
    expect(stats.lastUpload).toBe('2025-01-15');
    expect(stats.uploadsPerMonth).toEqual([
      { month: '2024-03', videos: 2 },
      { month: '2025-01', videos: 1 },
    ]);
  });

  it('omits the upload range when YouTube reported no dates', () => {
    const stats = computeStats([video({ uploadDate: '' })], []);

    expect(stats.firstUpload).toBeUndefined();
    expect(stats.lastUpload).toBeUndefined();
    expect(stats.uploadsPerMonth).toEqual([]);
  });
});

describe('findRecurringPhrases', () => {
  const catchphrase = 'smash that subscribe button';

  /**
   * Only the catchphrase is common to every video. Surrounding words differ, as
   * they do in reality, so a longer window cannot be the thing that recurs.
   */
  function videosSayingIt(count = PHRASE_MIN_VIDEOS): BrainChunk[] {
    return Array.from({ length: count }, (_unused, index) =>
      chunk(`v${index}`, `episode${index} ${catchphrase} topic${index}`)
    );
  }

  it('finds a phrase repeated across enough videos', () => {
    const phrases = findRecurringPhrases(videosSayingIt());

    expect(phrases.map((entry) => entry.phrase)).toContain(catchphrase);
  });

  it('ignores a phrase one video short of the threshold', () => {
    const phrases = findRecurringPhrases(videosSayingIt(PHRASE_MIN_VIDEOS - 1));

    expect(phrases).toEqual([]);
  });

  it('ignores a phrase repeated inside a single video', () => {
    const chunks = Array.from({ length: 10 }, (_unused, index) =>
      chunk('v1', `${catchphrase} again`, index)
    );

    expect(findRecurringPhrases(chunks)).toEqual([]);
  });

  it('drops truncations of a phrase it already reports', () => {
    const phrases = findRecurringPhrases(videosSayingIt()).map((entry) => entry.phrase);

    expect(phrases).toContain(catchphrase);
    expect(phrases).not.toContain('smash that subscribe');
    expect(phrases).not.toContain('that subscribe button');
  });

  it('ignores windows that are entirely filler', () => {
    const chunks = Array.from({ length: PHRASE_MIN_VIDEOS }, (_unused, index) =>
      chunk(`v${index}`, 'and it is the that this')
    );

    expect(findRecurringPhrases(chunks)).toEqual([]);
  });

  it('counts videos, not occurrences, when deciding what recurs', () => {
    const chunks = [
      chunk('v1', `${catchphrase} ${catchphrase}`),
      chunk('v2', catchphrase),
      chunk('v3', catchphrase),
    ];

    const found = findRecurringPhrases(chunks).find((entry) => entry.phrase === catchphrase);

    expect(found).toMatchObject({ videoCount: 3, occurrences: 4 });
  });
});
