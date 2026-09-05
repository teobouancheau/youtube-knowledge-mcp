import { join } from 'path';
import { mkdir } from 'fs/promises';
import { TIMEOUTS, parseYtDlpJson, runYtDlp } from './ytdlp.js';
import { YouTubeError } from './errors.js';
import { afterMoveRowSchema, formatsRowSchema } from './youtube-schemas.js';
import { resolveOutputDir } from './validate.js';
import { log } from './context.js';
import { dataDir } from './paths.js';
import { extractVideoId, watchUrl } from './youtube-url.js';

/** Format listing and whole-video downloads. */

const DOWNLOADS_DIR = dataDir('downloads');

export interface VideoFormat {
  formatId: string;
  ext: string;
  resolution: string;
  fps?: number;
  vcodec: string;
  acodec: string;
  filesize?: number;
  note: string;
}

export interface DownloadResult {
  videoId: string;
  title: string;
  filePath: string;
  format: string;
}

export async function listFormats(urlOrId: string): Promise<VideoFormat[]> {
  const videoId = extractVideoId(urlOrId);
  const url = watchUrl(videoId);
  const stdout = await runYtDlp(['-j', '--skip-download'], { label: 'list_formats', target: url });

  const data = parseYtDlpJson(stdout, formatsRowSchema, 'video formats');
  const formats = data.formats ?? [];

  return formats
    .filter((f) => !f.format_id.startsWith('sb')) // skip storyboards
    .map((f) => {
      const resolution =
        f.resolution ?? (f.width && f.height ? `${f.width}x${f.height}` : 'audio only');

      return {
        formatId: f.format_id,
        ext: f.ext,
        resolution,
        fps: f.fps ?? undefined,
        vcodec: f.vcodec ?? 'none',
        acodec: f.acodec ?? 'none',
        filesize: f.filesize ?? f.filesize_approx ?? undefined,
        note: f.format_note ?? '',
      };
    });
}

export type VideoQuality =
  'best' | '2160p' | '1440p' | '1080p' | '720p' | '480p' | '360p' | 'audio';

// Smart format selectors that use yt-dlp's fallback syntax
export const QUALITY_FORMAT_SELECTORS: Record<VideoQuality, string> = {
  best: 'bestvideo*+bestaudio/best',
  '2160p':
    'bestvideo[height<=2160]+bestaudio/bestvideo*[height<=2160]+bestaudio/best[height<=2160]/bestvideo+bestaudio/best',
  '1440p':
    'bestvideo[height<=1440]+bestaudio/bestvideo*[height<=1440]+bestaudio/best[height<=1440]/bestvideo+bestaudio/best',
  '1080p':
    'bestvideo[height<=1080]+bestaudio/bestvideo*[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best',
  '720p':
    'bestvideo[height<=720]+bestaudio/bestvideo*[height<=720]+bestaudio/best[height<=720]/bestvideo+bestaudio/best',
  '480p':
    'bestvideo[height<=480]+bestaudio/bestvideo*[height<=480]+bestaudio/best[height<=480]/bestvideo+bestaudio/best',
  '360p':
    'bestvideo[height<=360]+bestaudio/bestvideo*[height<=360]+bestaudio/best[height<=360]/bestvideo+bestaudio/best',
  audio: 'bestaudio/best',
};

export async function downloadVideo(
  urlOrId: string,
  formatId: string,
  outputDir?: string,
  quality?: VideoQuality
): Promise<DownloadResult> {
  const videoId = extractVideoId(urlOrId);
  const url = watchUrl(videoId);
  const targetDir = resolveOutputDir(outputDir, DOWNLOADS_DIR);

  // Ensure download directory exists
  await mkdir(targetDir, { recursive: true });

  // Download with specified format
  const outputTemplate = join(targetDir, '%(title)s.%(ext)s');

  // A quality preset always wins over formatId; that is what the tool schema
  // promises, and the two are resolved in exactly one place.
  const formatSelector = quality ? QUALITY_FORMAT_SELECTORS[quality] : formatId;

  // -S vcodec:h264,acodec:m4a prefers H.264+AAC, which merge cleanly into MP4.
  // The after_move print reports the title and the final path from the same
  // run, once the merge has produced the file, so nothing is spawned twice.
  const commonArgs = (selector: string): string[] => [
    '-f',
    selector,
    '-S',
    'vcodec:h264,acodec:m4a',
    '-o',
    outputTemplate,
    '--no-playlist',
    '--merge-output-format',
    'mp4',
    '--print',
    AFTER_MOVE_TEMPLATE,
  ];

  // Transfers are not retried automatically: a partial file on disk plus a
  // silent second attempt is worse than one clear failure.
  const downloadOptions = {
    label: 'download_video',
    timeoutMs: TIMEOUTS.download,
    retry: false,
    target: url,
  } as const;

  let stdout: string;
  try {
    stdout = await runYtDlp(commonArgs(formatSelector), downloadOptions);
  } catch (error) {
    // An explicitly requested format may simply not exist for this video, so
    // falling back to "best" is worth one attempt. A preset failing is not:
    // presets already encode their own fallback chain, and "best" failing
    // leaves nothing to fall back to.
    const alreadyBroadest = quality !== undefined || formatId === 'best';
    if (alreadyBroadest) throw error;

    log('warning', `format ${formatId} unavailable, falling back to best`);
    stdout = await runYtDlp(commonArgs(QUALITY_FORMAT_SELECTORS.best), downloadOptions);
  }

  const moved = readAfterMove(stdout);
  return {
    videoId,
    title: moved.title ?? '',
    filePath: moved.filepath,
    format: quality ?? formatId,
  };
}

/** The after_move print: the last JSON line yt-dlp wrote, with the path it wrote to. */
export const AFTER_MOVE_TEMPLATE = 'after_move:%(.{title,filepath})j';

export function readAfterMove(stdout: string): { title: string | undefined; filepath: string } {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
  const row = line === '' ? { title: undefined, filepath: undefined } : parseAfterMove(line);
  if (typeof row.filepath !== 'string' || row.filepath === '') {
    throw new YouTubeError(
      'YTDLP_FAILED',
      'yt-dlp finished without reporting where it wrote the file.',
      {
        nextStep: 'Run `yt-dlp -U`; older versions do not print the after_move stage.',
      }
    );
  }
  return { title: row.title ?? undefined, filepath: row.filepath };
}

function parseAfterMove(line: string): { title?: string | null; filepath?: string | null } {
  return parseYtDlpJson(line, afterMoveRowSchema, 'download result');
}
