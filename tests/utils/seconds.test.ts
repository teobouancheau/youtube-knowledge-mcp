import { describe, it, expect } from 'vitest';
import { MILLISECONDS_PER_SECOND, roundToMillisecond } from '../../src/utils/seconds.js';

describe('roundToMillisecond', () => {
  it.each([
    [1.23456, 1.235],
    [9.0004, 9],
    [2, 2],
    [0, 0],
    [125.9996, 126],
  ])('rounds %s to %s', (input, expected) => {
    expect(roundToMillisecond(input)).toBe(expected);
  });

  it('is expressed in the same unit whisper.cpp and ffmpeg count in', () => {
    expect(MILLISECONDS_PER_SECOND).toBe(1000);
  });
});
