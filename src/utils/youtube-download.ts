import { join } from 'path';
import { mkdir } from 'fs/promises';
import { TIMEOUTS, isRecord, parseYtDlpJson, runYtDlp } from './ytdlp.js';
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

interface YtDlpFormat {
  format_id: string;
  ext: string;
  resolution?: string;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
  format_note?: string;
}

export async function listFormats(urlOrId: string): Promise<VideoFormat[]> {
  const videoId = extractVideoId(urlOrId);
  const url = watchUrl(videoId);
  const stdout = await runYtDlp(['-j', '--skip-download'], { label: 'list_formats', target: url });

  const data = parseYtDlpJson<{ formats?: YtDlpFormat[] }>(stdout, isRecord, 'video formats');
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
        fps: f.fps,
        vcodec: f.vcodec ?? 'none',
        acodec: f.acodec ?? 'none',
        filesize: f.filesize ?? f.filesize_approx,
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

  // Get video title first for the result
  const titleOutput = await runYtDlp(['--skip-download', '--print', '%(title)s'], {
    label: 'download_video (title)',
    target: url,
  });
  const title = titleOutput.trim();

  // Download with specified format
  const outputTemplate = join(targetDir, '%(title)s.%(ext)s');

  // A quality preset always wins over formatId; that is what the tool schema
  // promises, and the two are resolved in exactly one place.
  const formatSelector = quality ? QUALITY_FORMAT_SELECTORS[quality] : formatId;

  // -S vcodec:h264,acodec:m4a prefers H.264+AAC, which merge cleanly into MP4.
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
  ];

  // Transfers are not retried automatically: a partial file on disk plus a
  // silent second attempt is worse than one clear failure.
  const downloadOptions = {
    label: 'download_video',
    timeoutMs: TIMEOUTS.download,
    retry: false,
    target: url,
  } as const;

  let effectiveSelector = formatSelector;
  try {
    await runYtDlp(commonArgs(formatSelector), downloadOptions);
  } catch (error) {
    // An explicitly requested format may simply not exist for this video, so
    // falling back to "best" is worth one attempt. A preset failing is not:
    // presets already encode their own fallback chain, and "best" failing
    // leaves nothing to fall back to.
    const alreadyBroadest = quality !== undefined || formatId === 'best';
    if (alreadyBroadest) throw error;

    log('warning', `format ${formatId} unavailable, falling back to best`);
    effectiveSelector = QUALITY_FORMAT_SELECTORS.best;
    await runYtDlp(commonArgs(effectiveSelector), downloadOptions);
  }

  // Ask yt-dlp what it actually named the file rather than guessing.
  const filenameOutput = await runYtDlp(
    [...commonArgs(effectiveSelector), '--print', 'filename', '--skip-download'],
    { label: 'download_video (filename)', target: url }
  );

  return {
    videoId,
    title,
    filePath: filenameOutput.trim(),
    format: quality ?? formatId,
  };
}
