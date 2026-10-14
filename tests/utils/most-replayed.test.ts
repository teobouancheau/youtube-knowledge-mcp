import { describe, it, expect } from 'vitest';
import { mostReplayed, type HeatSegment } from '../../src/utils/most-replayed.js';

/** Ten ten-second segments with the given replay values. */
function heatmap(values: number[]): HeatSegment[] {
  return values.map((value, index) => ({
    startSeconds: index * 10,
    endSeconds: (index + 1) * 10,
    value,
  }));
}

describe('mostReplayed', () => {
  const VALUES = [0.1, 0.2, 0.9, 0.95, 0.3, 0.1, 0.6, 0.2, 0.1, 0.8];

  it('returns the strongest moments first', () => {
    const peaks = mostReplayed(heatmap(VALUES), 3);

    expect(peaks.map((peak) => peak.value)).toEqual([0.95, 0.8, 0.6]);
  });

  it('counts a run of hot neighbours as one moment, not several', () => {
    // 0.9 sits right beside 0.95: it is the same spike, not a second one.
    const peaks = mostReplayed(heatmap(VALUES), 3);

    expect(peaks.map((peak) => peak.startSeconds)).toEqual([30, 90, 60]);
  });

  it('keeps the segment bounds so a moment can be opened or clipped', () => {
    const [top] = mostReplayed(heatmap(VALUES), 1);

    expect(top).toEqual({ startSeconds: 30, endSeconds: 40, value: 0.95 });
  });

  it('returns fewer moments than asked when the video has fewer distinct spikes', () => {
    expect(mostReplayed(heatmap([0.5, 0.4, 0.3]), 5)).toHaveLength(1);
  });

  it('returns nothing for an empty heatmap', () => {
    expect(mostReplayed([], 5)).toEqual([]);
  });

  it('returns nothing when asked for none', () => {
    expect(mostReplayed(heatmap(VALUES), 0)).toEqual([]);
  });

  it('does not reorder or change the heatmap it was given', () => {
    const input = heatmap(VALUES);
    const before = JSON.stringify(input);

    mostReplayed(input, 3);

    expect(JSON.stringify(input)).toBe(before);
  });
});
