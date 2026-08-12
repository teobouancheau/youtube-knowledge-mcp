import { execa } from 'execa';
import { YouTubeError } from './errors.js';

/**
 * External binary checks.
 *
 * yt-dlp breaking against YouTube changes is the single most common way this
 * server fails in the field, and a stale copy fails in confusing ways rather
 * than obvious ones. Checking at startup — and exposing the same check as a
 * tool — turns "everything returns errors" into one clear diagnosis.
 */

export interface BinaryStatus {
  name: string;
  installed: boolean;
  version?: string;
  /** Set when the binary works but should be updated. */
  warning?: string;
}

export interface PreflightReport {
  ok: boolean;
  ytDlp: BinaryStatus;
  ffmpeg: BinaryStatus;
}

/** yt-dlp versions are date-stamped (2025.11.03), which makes staleness measurable. */
const STALE_AFTER_DAYS = 45;
const PROBE_TIMEOUT_MS = 10_000;

let cached: PreflightReport | undefined;

async function probe(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execa(command, args, { timeout: PROBE_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export function parseYtDlpAgeDays(version: string, now: number): number | undefined {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version);
  if (!match) return undefined;

  const released = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.floor((now - released) / 86_400_000);
}

export async function runPreflight(options: { force?: boolean } = {}): Promise<PreflightReport> {
  if (cached && !options.force) return cached;

  const [ytDlpVersion, ffmpegVersion] = await Promise.all([
    probe('yt-dlp', ['--version']),
    probe('ffmpeg', ['-version']),
  ]);

  const ytDlp: BinaryStatus = { name: 'yt-dlp', installed: ytDlpVersion !== undefined };
  if (ytDlpVersion !== undefined) {
    ytDlp.version = ytDlpVersion;
    const ageDays = parseYtDlpAgeDays(ytDlpVersion, Date.now());
    if (ageDays !== undefined && ageDays > STALE_AFTER_DAYS) {
      ytDlp.warning = `yt-dlp ${ytDlpVersion} is ${ageDays} days old. YouTube changes often; run \`yt-dlp -U\` if extraction starts failing.`;
    }
  }

  const ffmpeg: BinaryStatus = { name: 'ffmpeg', installed: ffmpegVersion !== undefined };
  if (ffmpegVersion !== undefined) {
    // `ffmpeg -version` opens with "ffmpeg version 6.1.1 Copyright (c) ...".
    ffmpeg.version = /^ffmpeg version (\S+)/.exec(ffmpegVersion)?.[1] ?? 'unknown';
  }

  cached = { ok: ytDlp.installed, ytDlp, ffmpeg };
  return cached;
}

/** Test seam — the report is cached for the process lifetime in normal use. */
export function resetPreflightCache(): void {
  cached = undefined;
}

/** Throws a typed, actionable error when ffmpeg is needed but absent. */
export async function requireFfmpeg(operation: string): Promise<void> {
  const { ffmpeg } = await runPreflight();
  if (ffmpeg.installed) return;

  throw new YouTubeError(
    'FFMPEG_MISSING',
    `${operation} requires ffmpeg, which is not installed.`,
    {
      nextStep:
        'Install ffmpeg and make sure it is on PATH (macOS: `brew install ffmpeg`, Debian/Ubuntu: `apt install ffmpeg`, Windows: `winget install ffmpeg`).',
    }
  );
}

export function formatPreflightReport(report: PreflightReport): string {
  const lines: string[] = [report.ok ? '✓ Ready' : '✗ Not ready', ''];

  for (const binary of [report.ytDlp, report.ffmpeg]) {
    if (binary.installed) {
      lines.push(`${binary.name}: ${binary.version ?? 'installed'}`);
      if (binary.warning) lines.push(`  ! ${binary.warning}`);
    } else {
      lines.push(`${binary.name}: not installed`);
    }
  }

  if (!report.ytDlp.installed) {
    lines.push(
      '',
      'yt-dlp is required for every tool in this server.',
      'Install it with `pip install -U yt-dlp` or `brew install yt-dlp`, then restart.'
    );
  } else if (!report.ffmpeg.installed) {
    lines.push(
      '',
      'ffmpeg is missing. Metadata, transcripts and search still work, but downloads',
      'that merge separate video and audio streams, clip extraction and frame grabs do not.'
    );
  }

  return lines.join('\n');
}
