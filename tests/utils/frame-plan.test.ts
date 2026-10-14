import { describe, it, expect } from 'vitest';
import { planTimestamps } from '../../src/utils/frame-plan.js';

const DURATION = 600;

describe('planTimestamps', () => {
  it('returns explicit timestamps sorted and de-duplicated', () => {
    expect(planTimestamps({ timestamps: [30, 10, 30, 20] }, DURATION, 12)).toEqual([10, 20, 30]);
  });

  it('spaces a count evenly across the whole video, avoiding the very first and last frame', () => {
    // Slice midpoints: the first frame of a video is often black, the last may not exist.
    expect(planTimestamps({ count: 4 }, DURATION, 12)).toEqual([75, 225, 375, 525]);
  });

  it('spaces a count inside a start and end window', () => {
    expect(planTimestamps({ count: 2, start: 100, end: 200 }, DURATION, 12)).toEqual([125, 175]);
  });

  it('clamps an end past the video to the duration', () => {
    expect(planTimestamps({ count: 1, start: 500, end: 9999 }, DURATION, 12)).toEqual([550]);
  });

  it('accepts a count of one as the middle of the window', () => {
    expect(planTimestamps({ count: 1 }, DURATION, 12)).toEqual([300]);
  });

  it('prefers explicit timestamps over a count', () => {
    expect(planTimestamps({ timestamps: [5], count: 8 }, DURATION, 12)).toEqual([5]);
  });

  it('rejects a request that names neither timestamps nor a count', () => {
    expect(() => planTimestamps({}, DURATION, 12)).toThrow(/timestamps or a count/);
  });

  it('rejects an empty timestamp list', () => {
    expect(() => planTimestamps({ timestamps: [] }, DURATION, 12)).toThrow(/timestamps or a count/);
  });

  it('rejects more frames than the cap, naming the cap', () => {
    expect(() => planTimestamps({ count: 13 }, DURATION, 12)).toThrow(/at most 12/);
    expect(() =>
      planTimestamps({ timestamps: Array.from({ length: 13 }, (_, i) => i) }, DURATION, 12)
    ).toThrow(/at most 12/);
  });

  it('rejects a timestamp past the end of the video', () => {
    expect(() => planTimestamps({ timestamps: [10, 601] }, DURATION, 12)).toThrow(
      /past the end of this 600s video/
    );
  });

  it('rejects a window that ends before it starts', () => {
    expect(() => planTimestamps({ count: 2, start: 200, end: 100 }, DURATION, 12)).toThrow(
      /end must be later than start/
    );
  });

  it('rejects a window that starts past the end of the video', () => {
    expect(() => planTimestamps({ count: 2, start: 700 }, DURATION, 12)).toThrow(
      /past the end of this 600s video/
    );
  });

  it('rejects a non-positive count', () => {
    expect(() => planTimestamps({ count: 0 }, DURATION, 12)).toThrow(/at least 1/);
  });

  it('does not bound timestamps when the duration is unknown', () => {
    expect(planTimestamps({ timestamps: [100000] }, 0, 12)).toEqual([100000]);
  });
});
