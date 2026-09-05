import { describe, it, expect } from 'vitest';
import { formatCount, formatFilesize, formatYouTubeDate } from '../../src/utils/format.js';

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_000, '1K'],
    [1_500, '1.5K'],
    [999_999, '1000K'],
    [1_000_000, '1M'],
    [1_600_000_000, '1.6B'],
  ])('renders %d as %s', (count, expected) => {
    expect(formatCount(count)).toBe(expected);
  });

  it('drops a trailing .0 rather than writing 1.0K', () => {
    expect(formatCount(2_000)).toBe('2K');
    expect(formatCount(2_100)).toBe('2.1K');
  });
});

describe('formatYouTubeDate', () => {
  it('turns yt-dlp’s compact date into ISO', () => {
    expect(formatYouTubeDate('20240115')).toBe('2024-01-15');
  });

  it.each(['', 'NA', '2024'])('returns nothing for %s rather than a malformed date', (input) => {
    expect(formatYouTubeDate(input)).toBe('');
  });
});

describe('formatFilesize', () => {
  it.each([
    [512, '0.5 KB'],
    [1024, '1.0 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [3 * 1024 * 1024 * 1024, '3.00 GB'],
  ])('renders %d bytes as %s', (bytes, expected) => {
    expect(formatFilesize(bytes)).toBe(expected);
  });

  it.each([undefined, 0])('says Unknown for %s, rather than 0.0 KB', (bytes) => {
    expect(formatFilesize(bytes)).toBe('Unknown');
  });
});
