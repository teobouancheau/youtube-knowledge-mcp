import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRange, safeStem } from './clips.js';
import { YouTubeError } from './errors.js';
import { runFfmpeg } from './ffmpeg.js';
import { dataDir } from './paths.js';
import { requireFfmpeg } from './preflight.js';
import { resolveOutputDir } from './validate.js';
import {
  FFMPEG_NETWORK_INPUT_ARGS,
  PREVIEW_STREAM_SELECTOR,
  resolveStreamUrl,
} from './video-stream.js';
import { TIMEOUTS } from './ytdlp.js';

/**
 * A short animated GIF from a moment of a video.
 *
 * A GIF stores every frame whole, so its size grows with length, width and frame
 * rate far faster than a video's does. The length is therefore capped: past it the
 * file is one nobody can share, and a clip is the right tool.
 */

export const MAX_GIF_SECONDS = 15;
export const DEFAULT_GIF_WIDTH = 480;
export const DEFAULT_GIF_FPS = 12;

const GIFS_DIR = dataDir('gifs');

export interface GifResult {
  videoId: string;
  title: string;
  filePath: string;
  start: number;
  end: number;
  duration: number;
  width: number;
  fps: number;
  bytes: number;
}

export async function extractGif(
  video: string,
  rangeOptions: { start?: number; end?: number; chapter?: string },
  options: { width: number; fps: number; outputDir?: string }
): Promise<GifResult> {
  const { width, fps } = options;

  // Cheap local checks first: a missing ffmpeg, an unwritable destination or an
  // over-long range should fail now, not after a network round trip.
  await requireFfmpeg('GIF extraction');
  const targetDir = resolveOutputDir(options.outputDir, GIFS_DIR);

  const { range, title, videoId } = await resolveRange(video, rangeOptions);
  const duration = range.end - range.start;
  if (duration > MAX_GIF_SECONDS) {
    throw new YouTubeError(
      'INVALID_INPUT',
      `A GIF can be at most ${String(MAX_GIF_SECONDS)} seconds, and this range is ${String(Math.round(duration))}.`,
      { nextStep: 'Narrow the range, or use extract_clip for a longer excerpt.' }
    );
  }

  await mkdir(targetDir, { recursive: true });
  const mediaUrl = await resolveStreamUrl(videoId, PREVIEW_STREAM_SELECTOR, 'extract_gif');
  const filePath = join(
    targetDir,
    `${safeStem(title, videoId)} [${String(Math.round(range.start))}-${String(Math.round(range.end))}].gif`
  );

  try {
    await runFfmpeg(
      [
        ...FFMPEG_NETWORK_INPUT_ARGS,
        // Both before -i: seek there, then read only the range.
        '-ss',
        String(range.start),
        '-t',
        String(duration),
        '-i',
        mediaUrl,
        '-vf',
        // The palette is built from this clip's own frames, which is what keeps the
        // colours faithful within a GIF's 256.
        `fps=${String(fps)},scale=${String(width)}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
        '-loop',
        '0',
        '-y',
        filePath,
      ],
      {
        failure: 'ffmpeg could not make that GIF.',
        nextStep: 'Try a shorter range, or check that ffmpeg works with network input.',
        timeoutMs: TIMEOUTS.transcript,
      }
    );
  } catch (error) {
    // ffmpeg writes as it goes, so a failed or cancelled run leaves half a GIF behind.
    await rm(filePath, { force: true });
    throw error;
  }

  return {
    videoId,
    title,
    filePath,
    start: range.start,
    end: range.end,
    duration,
    width,
    fps,
    bytes: (await stat(filePath)).size,
  };
}
