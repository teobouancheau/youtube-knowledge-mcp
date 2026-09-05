import { describe, it, expect } from 'vitest';
import { MAX_PATTERN_LENGTH, assertSafePattern, compilePattern } from '../../src/utils/pattern.js';
import { YouTubeError } from '../../src/utils/errors.js';

function caught(fn: () => unknown): YouTubeError | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof YouTubeError ? error : undefined;
  }
}

describe('assertSafePattern', () => {
  // Each of these backtracks exponentially on a non-matching input.
  it.each([
    ['a repeated group with repetition', '(a+)+'],
    ['a starred group with a star', '(a*)*'],
    ['a repeated group with alternation', '(a|aa)+'],
    ['a bounded repeat of an optional group', '(a?){5}'],
    ['nesting two levels deep', '((ab)*)+'],
    ['a realistic one', '(\\d+\\s?)+'],
    ['a repeated non-capturing group with repetition', '(?:x+)*'],
    ['a lazy repeat of a repeated group', '(a+)+?'],
  ])('rejects %s: %s', (_label, source) => {
    const error = caught(() => {
      assertSafePattern(source);
    });
    expect(error?.code).toBe('INVALID_INPUT');
    expect(error?.toToolMessage()).toContain('regex=false');
  });

  it.each(['(a)\\1', '(?<n>a)\\k<n>'])('rejects the backreference in %s', (source) => {
    expect(
      caught(() => {
        assertSafePattern(source);
      })?.code
    ).toBe('INVALID_INPUT');
  });

  it('caps the length', () => {
    expect(() => {
      assertSafePattern('a'.repeat(MAX_PATTERN_LENGTH));
    }).not.toThrow();
    expect(
      caught(() => {
        assertSafePattern('a'.repeat(MAX_PATTERN_LENGTH + 1));
      })?.code
    ).toBe('INVALID_INPUT');
  });

  // Ordinary patterns people actually type must keep working.
  it.each([
    'rate\\s+limiting',
    'colou?r',
    '(cat|dog)s?',
    '(?:foo)+',
    '(?=ab)c',
    '(?!ab)c',
    '(?<=ab)c',
    '(?<!ab)c',
    '(?<word>ab)+',
    '(?<word',
    '[a-z]+',
    'a{2,4}',
    '^\\d{1,3}$',
    '[+*|]+',
    '[\\]a]+',
    'foo(bar)baz',
    '(a)(b)(c)',
    '(a+)(b+)',
    'x{3}',
    'a\\.b',
    '\\bword\\b',
  ])('accepts %s', (source) => {
    expect(() => {
      assertSafePattern(source);
    }).not.toThrow();
  });
});

describe('compilePattern', () => {
  it('escapes a literal query', () => {
    const pattern = compilePattern('a.b', { regex: false, caseSensitive: false });
    expect(pattern.test('a.b')).toBe(true);
    expect(pattern.test('axb')).toBe(false);
  });

  it('compiles a regex query with the global flag the search relies on', () => {
    expect(compilePattern('a.b', { regex: true, caseSensitive: false }).flags).toBe('gi');
    expect(compilePattern('a.b', { regex: true, caseSensitive: true }).flags).toBe('g');
  });

  it('rejects an invalid pattern with the literal-search way out', () => {
    const error = caught(() => compilePattern('(unclosed', { regex: true, caseSensitive: false }));
    expect(error?.code).toBe('INVALID_INPUT');
    expect(error?.toToolMessage()).toContain('regex=false');
  });

  it('rejects a catastrophic pattern before compiling it', () => {
    expect(
      caught(() => compilePattern('(a+)+$', { regex: true, caseSensitive: false }))?.code
    ).toBe('INVALID_INPUT');
  });

  it('does not apply the backtracking rule to literal queries', () => {
    expect(() => compilePattern('(a+)+', { regex: false, caseSensitive: false })).not.toThrow();
  });
});
