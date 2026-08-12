import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertLanguageTag, parseTimestamp, resolveOutputDir } from '../../src/utils/validate.js';
import { YouTubeError } from '../../src/utils/errors.js';

const HOME = homedir();
const FALLBACK = join(HOME, '.youtube-knowledge', 'downloads');

describe('resolveOutputDir', () => {
  it('falls back when no directory is given', () => {
    expect(resolveOutputDir(undefined, FALLBACK)).toBe(FALLBACK);
    expect(resolveOutputDir('', FALLBACK)).toBe(FALLBACK);
    expect(resolveOutputDir('   ', FALLBACK)).toBe(FALLBACK);
  });

  it('accepts a path inside the home directory', () => {
    expect(resolveOutputDir(join(HOME, 'Videos'), FALLBACK)).toBe(join(HOME, 'Videos'));
  });

  it('expands a leading tilde', () => {
    expect(resolveOutputDir('~/Videos', FALLBACK)).toBe(join(HOME, 'Videos'));
  });

  it('accepts the home directory itself', () => {
    expect(resolveOutputDir(HOME, FALLBACK)).toBe(HOME);
  });

  // A tool argument is model-controlled, so these must not be writable targets.
  it.each([
    ['an absolute path outside home', '/etc'],
    ['a traversal escape', join(HOME, '..', '..', 'etc')],
    ['a tilde traversal escape', '~/../../etc'],
    ['the filesystem root', '/'],
  ])('rejects %s', (_label, path) => {
    expect(() => resolveOutputDir(path, FALLBACK)).toThrow(YouTubeError);
  });

  it('rejects a path containing a NUL byte', () => {
    expect(() => resolveOutputDir(`${HOME}/evil\0.mp4`, FALLBACK)).toThrow(YouTubeError);
  });

  it('names a usable alternative when it rejects', () => {
    const error = (() => {
      try {
        resolveOutputDir('/etc', FALLBACK);
        return undefined;
      } catch (e) {
        return e as YouTubeError;
      }
    })();

    expect(error?.code).toBe('INVALID_INPUT');
    expect(error?.toToolMessage()).toContain(HOME);
  });
});

describe('assertLanguageTag', () => {
  it.each(['en', 'fr', 'pt-BR', 'zh-Hans', 'es-419'])('accepts %s', (tag) => {
    expect(assertLanguageTag(tag)).toBe(tag);
  });

  it.each(['', 'e', '../../etc/passwd', 'en;rm -rf /', 'en_US!', '--write-sub'])(
    'rejects %s',
    (tag) => {
      expect(() => assertLanguageTag(tag)).toThrow(YouTubeError);
    }
  );
});

describe('parseTimestamp', () => {
  it.each([
    ['90', 90],
    ['1:30', 90],
    ['01:30', 90],
    ['1:02:03', 3723],
    ['0:00', 0],
    ['1:30.5', 90.5],
  ])('parses %s to %d seconds', (input, expected) => {
    expect(parseTimestamp(input, 'start')).toBe(expected);
  });

  it('passes numbers through', () => {
    expect(parseTimestamp(42, 'start')).toBe(42);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects the number %s', (value) => {
    expect(() => parseTimestamp(value, 'start')).toThrow(YouTubeError);
  });

  it.each(['abc', '1:99', '::', '1:2:3:4', ''])('rejects the string %s', (value) => {
    expect(() => parseTimestamp(value, 'start')).toThrow(YouTubeError);
  });

  it('names the offending field and shows the accepted formats', () => {
    const error = (() => {
      try {
        parseTimestamp('abc', 'endTime');
        return undefined;
      } catch (e) {
        return e as YouTubeError;
      }
    })();

    expect(error?.message).toContain('endTime');
    expect(error?.toToolMessage()).toContain('HH:MM:SS');
  });
});
