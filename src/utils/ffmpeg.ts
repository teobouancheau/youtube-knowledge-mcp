import { execa } from 'execa';
import { currentContext } from './context.js';
import { YouTubeError } from './errors.js';

/**
 * The one place this server runs ffmpeg.
 *
 * Every tool that looks at or cuts a video ends in an ffmpeg process, and each needs
 * the same three things: it must stop when the client cancels the request, it must stop
 * after a time budget, and its failure must reach the caller as a typed, actionable error
 * rather than a raw process error. Kept here, a tool cannot forget one of them.
 */

/** JPEG quality on ffmpeg's 2 (best) to 31 (worst) scale. */
export const FFMPEG_JPEG_QUALITY = '4';

export interface FfmpegRun {
  /** What was being done, as the failure message: "ffmpeg could not make that GIF." */
  failure: string;
  /** What the caller should try next. */
  nextStep: string;
  /** Milliseconds before the process is killed. 0 disables the budget. */
  timeoutMs: number;
  /** Bytes written to ffmpeg's standard input. */
  input?: Uint8Array;
}

export interface FfmpegOutput {
  stdout: Buffer;
  stderr: string;
}

export async function runFfmpeg(args: string[], run: FfmpegRun): Promise<FfmpegOutput> {
  try {
    const result = await execa('ffmpeg', args, {
      encoding: 'buffer',
      timeout: run.timeoutMs,
      cancelSignal: currentContext().signal,
      ...(run.input === undefined ? {} : { input: run.input }),
    });
    return { stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr).toString() };
  } catch (error) {
    throw new YouTubeError('YTDLP_FAILED', run.failure, { nextStep: run.nextStep, cause: error });
  }
}
