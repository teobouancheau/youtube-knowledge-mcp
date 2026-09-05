import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

/**
 * Containment is checked on the real path. These tests need a home directory
 * they can put a symlink in, so `homedir()` is pointed at a temporary one.
 */
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});

import { assertInsideHome, resolveOutputDir } from '../../src/utils/validate.js';
import { YouTubeError } from '../../src/utils/errors.js';

let home: string;
let outside: string;

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'validate-home-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'validate-outside-')));
  process.env.TEST_HOME = home;
  await mkdir(join(home, 'real'));
  await symlink(outside, join(home, 'escape'));
});

afterAll(async () => {
  delete process.env.TEST_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('assertInsideHome', () => {
  it('accepts a real directory under home', () => {
    expect(assertInsideHome(join(home, 'real'), 'output directory')).toBe(join(home, 'real'));
  });

  it('accepts a directory that does not exist yet, judged by where it would be created', () => {
    expect(assertInsideHome(join(home, 'real', 'new', 'deeper'), 'output directory')).toBe(
      join(home, 'real', 'new', 'deeper')
    );
  });

  // The lexical check passed this: the path starts with home. The real path
  // does not, and that is where yt-dlp and ffmpeg would have written.
  it('rejects a symlink inside home that points outside it', () => {
    expect(() => assertInsideHome(join(home, 'escape'), 'output directory')).toThrow(YouTubeError);
    expect(() => assertInsideHome(join(home, 'escape', 'sub'), 'output directory')).toThrow(
      YouTubeError
    );
  });

  it('rejects a NUL byte before touching the filesystem', () => {
    expect(() => assertInsideHome(`~/real\0`, 'cookies file')).toThrow(/cookies file/);
  });

  it('names what was being validated', () => {
    const error = (() => {
      try {
        assertInsideHome('/etc', 'cookies file');
        return undefined;
      } catch (e) {
        return e as YouTubeError;
      }
    })();
    expect(error?.message).toContain('cookies file');
  });
});

describe('resolveOutputDir (real paths)', () => {
  it('expands a tilde against the mocked home', () => {
    expect(resolveOutputDir('~/real', '/fallback')).toBe(join(home, 'real'));
  });
});
