import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { YouTubeError } from './errors.js';

/**
 * Input validation for the values that reach the filesystem or yt-dlp's
 * language negotiation. The YouTube-specific checks — ids and URLs — live in
 * validate-youtube.ts and are re-exported here. Zod already constrains shapes at the tool boundary;
 * these are the checks Zod cannot express.
 */

/**
 * Resolve a caller-supplied output directory.
 *
 * A tool argument is model-controlled, so it must not be able to write outside
 * the user's home directory or reach the filesystem root through `..`.
 */
export function resolveOutputDir(outputDir: string | undefined, fallback: string): string {
  if (outputDir === undefined || outputDir.trim() === '') return fallback;

  const expanded = outputDir.startsWith('~')
    ? resolve(homedir(), outputDir.slice(1).replace(/^[/\\]/, ''))
    : resolve(normalize(outputDir));

  if (expanded.includes('\0')) {
    throw new YouTubeError('INVALID_INPUT', 'The output directory path is not valid.', {
      nextStep: 'Provide a plain directory path, for example ~/Videos.',
    });
  }

  const home = resolve(homedir());
  if (!isAbsolute(expanded) || !(expanded === home || expanded.startsWith(home + sep))) {
    throw new YouTubeError(
      'INVALID_INPUT',
      'Downloads must be written inside your home directory.',
      {
        nextStep: `Choose a path under ${home}, or omit outputDir to use the default location.`,
      }
    );
  }

  return expanded;
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
