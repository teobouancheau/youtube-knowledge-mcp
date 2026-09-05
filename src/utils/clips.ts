import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { execa } from 'execa';
import { YouTubeError } from './errors.js';
import { requireFfmpeg } from './preflight.js';
import { resolveOutputDir } from './validate.js';
import { TIMEOUTS, runYtDlp } from './ytdlp.js';
import { formatSrtTimestamp } from './transcript.js';
import { getChapters, getVideoInfo } from './youtube.js';
import { dataDir } from './paths.js';

/**
 * Pulling usable excerpts out of a video for editing.
 *
 * Until now the only way to get a twenty-second clip was to download the whole
 * video and cut it by hand. yt-dlp's --download-sections fetches just the byte
 * range that covers the requested window, which is both far faster and far
 * kinder to YouTube than pulling a three-hour file to keep 20 seconds of it.
 */

const CLIPS_DIR = dataDir('clips');
const FRAMES_DIR = dataDir('frames');
const SUBTITLES_DIR = dataDir('subtitles');

export interface ClipRange {
  start: number;
  end: number;
}

export interface ClipResult {
  videoId: string;
  title: string;
  filePath: string;
  start: number;
  end: number;
  duration: number;
}

/**
 * Filesystem-safe stem derived from the video title.
 *
 * Video titles are arbitrary remote text that ends up as a filename, so path
 * separators, Windows-reserved characters and control codes are stripped rather
 * than trusted.
 */
export function safeStem(title: string, fallback: string): string {
  const cleaned = title
    // Whitespace first: tabs and newlines are control characters, and should
    // collapse to a space rather than vanish and run two words together.
    .replace(/\s+/g, ' ')
    // \p{C} then removes what is left — NUL, other control codes, and the
    // invisible formatting characters — without putting any in the source.
    .replace(/\p{C}/gu, '')
    .replace(/[/\\?%*:|"<>]/g, '')
    // A leading dot would make the file hidden, or worse, be read as a relative path.
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80)
    .trim();

  return cleaned === '' ? fallback : cleaned;
}

/**
 * Validate a requested range against the video's real duration.
 *
 * Checking first means an impossible range fails in a second with a useful
 * message, instead of after yt-dlp has spent a minute discovering the same
 * thing and reporting it obscurely.
 */
export async function resolveRange(
  video: string,
  options: { start?: number; end?: number; chapter?: string }
): Promise<{ range: ClipRange; title: string; videoId: string; duration: number }> {
  const info = await getVideoInfo(video);

  let range: ClipRange;

  if (options.chapter !== undefined) {
    const chapters = await getChapters(video);
    if (chapters.length === 0) {
      throw new YouTubeError('NOT_FOUND', 'This video has no chapters.', {
        nextStep: 'Pass start and end instead.',
      });
    }

    const wanted = options.chapter.toLowerCase();
    const match =
      chapters.find((chapter) => chapter.title.toLowerCase() === wanted) ??
      chapters.find((chapter) => chapter.title.toLowerCase().includes(wanted));

    if (!match) {
      throw new YouTubeError('NOT_FOUND', `No chapter matches "${options.chapter}".`, {
        nextStep: `Available chapters: ${chapters.map((chapter) => chapter.title).join(', ')}`,
      });
    }
    range = { start: match.startTime, end: match.endTime };
  } else {
    if (options.start === undefined || options.end === undefined) {
      throw new YouTubeError('INVALID_INPUT', 'Provide both start and end, or a chapter name.', {
        nextStep: 'Use search_transcript to find the moment you want, then pass its timestamp.',
      });
    }
    range = { start: options.start, end: options.end };
  }

  if (range.end <= range.start) {
    throw new YouTubeError('INVALID_INPUT', 'end must be later than start.');
  }

  if (info.duration > 0 && range.start >= info.duration) {
    throw new YouTubeError(
      'INVALID_INPUT',
      `start (${Math.round(range.start)}s) is past the end of this ${info.duration}s video.`,
      { nextStep: 'Pick a start time inside the video.' }
    );
  }

  // Clamp rather than reject: asking for "the last 30 seconds" by overshooting
  // is a reasonable thing to do.
  if (info.duration > 0 && range.end > info.duration) {
    range = { ...range, end: info.duration };
  }

  return { range, title: info.title, videoId: info.id, duration: info.duration };
}

function sectionArg(range: ClipRange): string {
  return `*${formatSrtTimestamp(range.start).replace(',', '.')}-${formatSrtTimestamp(range.end).replace(',', '.')}`;
}

export interface ExtractClipOptions {
  formatSelector: string;
  outputDir?: string;
  preciseCuts: boolean;
  /** Container to remux into; also decides the file extension. */
  container: string;
  audioOnly?: boolean;
  audioFormat?: string;
}

export async function extractClip(
  video: string,
  rangeOptions: { start?: number; end?: number; chapter?: string },
  options: ExtractClipOptions
): Promise<ClipResult> {
  // Cheap local checks first: a missing ffmpeg or an unwritable destination
  // should fail immediately, not after a network round trip.
  await requireFfmpeg('Clip extraction');
  const targetDir = resolveOutputDir(options.outputDir, CLIPS_DIR);

  const { range, title, videoId } = await resolveRange(video, rangeOptions);
  await mkdir(targetDir, { recursive: true });

  const stem = `${safeStem(title, videoId)} [${Math.round(range.start)}-${Math.round(range.end)}]`;
  const outputTemplate = join(targetDir, `${stem}.%(ext)s`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const args = [
    '-f',
    options.formatSelector,
    '--download-sections',
    sectionArg(range),
    '-o',
    outputTemplate,
    '--no-playlist',
  ];

  if (options.preciseCuts) {
    // Without this yt-dlp cuts on keyframes, which can be seconds off. It costs
    // a re-encode, so it is opt-out rather than mandatory.
    args.push('--force-keyframes-at-cuts');
  }

  if (options.audioOnly) {
    args.push('--extract-audio', '--audio-format', options.audioFormat ?? 'mp3');
  } else {
    args.push('--merge-output-format', options.container);
  }

  await runYtDlp(args, {
    label: 'extract_clip',
    timeoutMs: TIMEOUTS.download,
    retry: false,
    target: url,
  });

  const filenameOutput = await runYtDlp([...args, '--print', 'filename', '--skip-download'], {
    label: 'extract_clip (filename)',
    target: url,
  });

  const extension = options.audioOnly ? (options.audioFormat ?? 'mp3') : options.container;
  const reported = filenameOutput.trim();
  const filePath =
    reported === ''
      ? join(targetDir, `${stem}.${extension}`)
      : replaceExtension(reported, extension);

  return {
    videoId,
    title,
    filePath,
    start: range.start,
    end: range.end,
    duration: range.end - range.start,
  };
}

function replaceExtension(path: string, extension: string): string {
  return path.replace(/\.[^./\\]+$/, `.${extension}`);
}

export interface FrameResult {
  videoId: string;
  title: string;
  filePath: string;
  timestamp: number;
}

/**
 * Grab a single still.
 *
 * Resolves the media URL with yt-dlp and hands it to ffmpeg, so nothing larger
 * than the frame itself is ever transferred.
 */
export async function extractFrame(
  video: string,
  timestamp: number,
  options: { outputDir?: string; format: 'png' | 'jpg' }
): Promise<FrameResult> {
  await requireFfmpeg('Frame extraction');
  const targetDir = resolveOutputDir(options.outputDir, FRAMES_DIR);

  const info = await getVideoInfo(video);

  if (info.duration > 0 && timestamp >= info.duration) {
    throw new YouTubeError(
      'INVALID_INPUT',
      `${Math.round(timestamp)}s is past the end of this ${info.duration}s video.`,
      { nextStep: 'Pick a timestamp inside the video.' }
    );
  }

  await mkdir(targetDir, { recursive: true });

  const url = `https://www.youtube.com/watch?v=${info.id}`;
  const mediaUrl = (
    await runYtDlp(['-f', 'bestvideo[height<=1080]/best', '--get-url', '--no-playlist'], {
      label: 'extract_frame (resolve)',
      target: url,
    })
  )
    .trim()
    .split('\n')[0];

  if (mediaUrl === undefined || mediaUrl === '') {
    throw new YouTubeError('YTDLP_FAILED', 'Could not resolve a video stream for this video.', {
      nextStep: 'Check the video is playable, or call check_health.',
    });
  }

  const filePath = join(
    targetDir,
    `${safeStem(info.title, info.id)} [${Math.round(timestamp)}s].${options.format}`
  );

  try {
    await execa(
      'ffmpeg',
      [
        // -ss before -i seeks without decoding everything up to that point.
        '-ss',
        String(timestamp),
        '-i',
        mediaUrl,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-y',
        filePath,
      ],
      { timeout: TIMEOUTS.transcript }
    );
  } catch (error) {
    throw new YouTubeError('YTDLP_FAILED', 'ffmpeg could not capture that frame.', {
      nextStep: 'Try a different timestamp, or check that ffmpeg works with network input.',
      cause: error,
    });
  }

  return { videoId: info.id, title: info.title, filePath, timestamp };
}

export function subtitlesDir(): string {
  return SUBTITLES_DIR;
}
