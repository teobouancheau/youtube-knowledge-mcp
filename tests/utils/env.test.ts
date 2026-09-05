import { describe, it, expect, vi, afterEach } from 'vitest';
import { envBool, envEnum, envInt, envList, envString } from '../../src/utils/env.js';

const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

afterEach(() => {
  stderr.mockClear();
});

describe('envString', () => {
  it('trims and treats blank as unset', () => {
    expect(envString('X', { X: '  a ' })).toBe('a');
    expect(envString('X', { X: '   ' })).toBeUndefined();
    expect(envString('X', {})).toBeUndefined();
  });
});

describe('envInt', () => {
  it('parses a whole number', () => {
    expect(envInt('X', 3, {}, { X: '7' })).toBe(7);
  });

  it('falls back when unset', () => {
    expect(envInt('X', 3, {}, {})).toBe(3);
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each(['abc', '1.5', 'NaN', 'Infinity'])('falls back and warns on %j', (raw) => {
    expect(envInt('X', 3, {}, { X: raw })).toBe(3);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('X'));
  });

  it('treats a blank value as unset, without a warning', () => {
    expect(envInt('X', 3, {}, { X: '  ' })).toBe(3);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('enforces the minimum, so a zero concurrency cannot deadlock the limiter', () => {
    expect(envInt('X', 3, { min: 1 }, { X: '0' })).toBe(3);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('minimum'));
  });

  it('enforces the maximum', () => {
    expect(envInt('X', 3, { max: 10 }, { X: '11' })).toBe(3);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('maximum'));
  });

  it('accepts the bounds themselves', () => {
    expect(envInt('X', 3, { min: 1, max: 10 }, { X: '1' })).toBe(1);
    expect(envInt('X', 3, { min: 1, max: 10 }, { X: '10' })).toBe(10);
  });
});

describe('envBool', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('reads %s as true', (raw) => {
    expect(envBool('X', false, { X: raw })).toBe(true);
  });

  it.each(['0', 'false', 'No', 'off'])('reads %s as false', (raw) => {
    expect(envBool('X', true, { X: raw })).toBe(false);
  });

  it('falls back when unset or unreadable', () => {
    expect(envBool('X', true, {})).toBe(true);
    expect(envBool('X', false, { X: 'maybe' })).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('boolean'));
  });
});

describe('envList', () => {
  it('splits on commas and drops blanks', () => {
    expect(envList('X', { X: 'a, b,,c ' })).toEqual(['a', 'b', 'c']);
    expect(envList('X', {})).toEqual([]);
  });
});

describe('envEnum', () => {
  const BROWSERS = ['chrome', 'firefox'] as const;

  it('returns the matching value, case-insensitively', () => {
    expect(envEnum('X', BROWSERS, { X: 'Firefox' })).toBe('firefox');
  });

  it('returns undefined when unset', () => {
    expect(envEnum('X', BROWSERS, {})).toBeUndefined();
  });

  it('throws on an unknown value, naming the accepted ones', () => {
    expect(() => envEnum('X', BROWSERS, { X: 'netscape' })).toThrow(/chrome, firefox/);
  });
});
