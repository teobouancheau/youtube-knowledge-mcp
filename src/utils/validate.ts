import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { YouTubeError } from './errors.js';

/**
 * Input validation for the values that reach the filesystem or yt-dlp's
 * language negotiation. The YouTube-specific checks — ids and URLs — live in
 * validate-youtube.ts and are re-exported here. Zod already constrains shapes at the tool boundary;
 * these are the checks Zod cannot express.
 */

/**
 * Prove that a caller-supplied path lies inside the home directory.
 *
 * A tool argument is model-controlled, so it must not be able to write outside
 * the user's home directory or reach the filesystem root through `..`. The
 * check is made on the real path: a symlink inside home that points outside it
 * passed a purely lexical comparison, and yt-dlp and ffmpeg then wrote through
 * it. The nearest existing ancestor is resolved and the missing tail re-joined,
 * so a directory that does not exist yet is judged by where it would be created.
 */
export function assertInsideHome(input: string, what: string): string {
  if (input.includes('\0')) {
    throw new YouTubeError('INVALID_INPUT', `The ${what} path is not valid.`, {
      nextStep: 'Provide a plain path, for example ~/Videos.',
    });
  }

  const expanded = input.startsWith('~')
    ? resolve(homedir(), input.slice(1).replace(/^[/\\]/, ''))
    : resolve(normalize(input));

  const home = realpathSync(homedir());
  const real = realpathOfNearestAncestor(expanded);

  if (!isAbsolute(real) || !(real === home || real.startsWith(home + sep))) {
    throw new YouTubeError('INVALID_INPUT', `The ${what} must be inside your home directory.`, {
      nextStep: `Choose a path under ${home}, or omit it to use the default location.`,
    });
  }

  return real;
}

/**
 * The real path of `target`, resolving symlinks in whichever prefix of it
 * exists. The walk stops at the filesystem root, which always exists.
 */
function realpathOfNearestAncestor(target: string): string {
  const missing: string[] = [];
  let probe = target;

  while (dirname(probe) !== probe && !existsSync(probe)) {
    missing.unshift(basename(probe));
    probe = dirname(probe);
  }

  return join(realpathSync(probe), ...missing);
}

/** Resolve a caller-supplied output directory, or the fallback when none is given. */
export function resolveOutputDir(outputDir: string | undefined, fallback: string): string {
  if (outputDir === undefined || outputDir.trim() === '') return fallback;
  return assertInsideHome(outputDir, 'output directory');
}

/** BCP-47-ish: `en`, `pt-BR`, `zh-Hans`, plus yt-dlp's `-orig` suffix. */
const LANGUAGE_PATTERN = /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{2,8})*$/;

export function assertLanguageTag(language: string): string {
  if (!LANGUAGE_PATTERN.test(language)) {
    throw new YouTubeError('INVALID_INPUT', `"${language}" is not a valid language code.`, {
      nextStep: 'Use a BCP-47 code such as "en", "fr", "es" or "pt-BR".',
    });
  }
  return language;
}

/** Accepts `90`, `1:30`, `01:02:03`, `1:30.5` and returns seconds. */
export function parseTimestamp(value: string | number, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new YouTubeError('INVALID_INPUT', `${field} must be a non-negative number of seconds.`);
    }
    return value;
  }

  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  const match = /^(?:(\d+):)?([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(trimmed);
  if (!match) {
    throw new YouTubeError('INVALID_INPUT', `${field} ("${value}") is not a valid timestamp.`, {
      nextStep: 'Use seconds (90), MM:SS (1:30), or HH:MM:SS (01:02:03).',
    });
  }

  // The hours group is optional, so it is genuinely absent for "MM:SS" input.
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

export * from './validate-youtube.js';
