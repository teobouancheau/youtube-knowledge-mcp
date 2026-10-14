import { execa } from 'execa';
import { readFile, rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import { currentContext } from './context.js';
import { envString } from './env.js';
import { YouTubeError } from './errors.js';
import { MILLISECONDS_PER_SECOND } from './seconds.js';
import type { TranscriptSegment } from './transcript.js';

/**
 * Transcribing audio on this machine, with whisper.cpp.
 *
 * For a video with no captions this is the only way to get words out of it. It is
 * strictly optional, like ffmpeg: nothing here runs unless a person asks for a local
 * transcription, and no model is downloaded for them. The model is a file they point
 * `YOUTUBE_MCP_WHISPER_MODEL` at, because which one to run is a trade between speed,
 * disk and accuracy that this server cannot make for them.
 */

/** The executable's name since whisper.cpp 1.7; earlier releases called it `main`. */
export const WHISPER_BINARY = 'whisper-cli';

const PROBE_TIMEOUT_MS = 5_000;
/** whisper.cpp writes this for a stretch with no speech; it is not part of what was said. */
const SILENCE_MARKER = '[BLANK_AUDIO]';

export interface WhisperStatus {
  installed: boolean;
  version?: string;
  /** The path the person configured, whether or not a file is there. */
  modelPath?: string;
  modelFound: boolean;
}

const whisperOutputSchema = z.object({
  transcription: z.array(
    z.object({
      offsets: z.object({ from: z.number(), to: z.number() }),
      text: z.string(),
    })
  ),
});

function configuredModel(): string | undefined {
  return envString('YOUTUBE_MCP_WHISPER_MODEL');
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function probeWhisper(): Promise<WhisperStatus> {
  const modelPath = configuredModel();
  const modelFound = modelPath !== undefined && (await isFile(modelPath));
  const model = modelPath === undefined ? {} : { modelPath };

  try {
    const { stdout } = await execa(WHISPER_BINARY, ['--version'], { timeout: PROBE_TIMEOUT_MS });
    const version = /version:\s*(\S+)/.exec(stdout)?.[1] ?? 'unknown';
    return { installed: true, version, ...model, modelFound };
  } catch {
    return { installed: false, ...model, modelFound };
  }
}

/** The model to run, or the typed reason there is nothing to run. */
export async function requireWhisper(operation: string): Promise<string> {
  const status = await probeWhisper();

  if (!status.installed) {
    throw new YouTubeError(
      'WHISPER_MISSING',
      `${operation} requires whisper.cpp, which is not installed.`,
      {
        nextStep:
          'Install whisper.cpp (macOS: `brew install whisper.cpp`; elsewhere build it from https://github.com/ggml-org/whisper.cpp) so that `whisper-cli` is on PATH, then call check_health.',
      }
    );
  }

  if (status.modelPath === undefined) {
    throw new YouTubeError(
      'WHISPER_MISSING',
      `${operation} needs a whisper model, and none is configured.`,
      {
        nextStep:
          'Download a ggml model file (for example ggml-base.bin from https://huggingface.co/ggerganov/whisper.cpp) and set YOUTUBE_MCP_WHISPER_MODEL to its path.',
      }
    );
  }

  if (!status.modelFound) {
    throw new YouTubeError(
      'WHISPER_MISSING',
      `The whisper model at ${status.modelPath} is not a readable file.`,
      { nextStep: 'Fix the path in YOUTUBE_MCP_WHISPER_MODEL, then call check_health.' }
    );
  }

  return status.modelPath;
}

/** whisper.cpp's JSON as segments in seconds; the silence marker is dropped. */
export function parseWhisperJson(raw: string): TranscriptSegment[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new YouTubeError('MALFORMED_RESPONSE', 'whisper.cpp wrote output that is not JSON.', {
      cause: error,
    });
  }

  const parsed = whisperOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new YouTubeError(
      'MALFORMED_RESPONSE',
      'whisper.cpp wrote JSON without a transcription.',
      { cause: parsed.error }
    );
  }

  return parsed.data.transcription
    .map(({ offsets, text }) => ({
      start: offsets.from / MILLISECONDS_PER_SECOND,
      end: offsets.to / MILLISECONDS_PER_SECOND,
      text: text.trim(),
    }))
    .filter((segment) => segment.text !== '' && segment.text !== SILENCE_MARKER);
}

/**
 * The language as whisper.cpp names it: the primary subtag, lower-case.
 *
 * Callers pass BCP-47 tags such as `pt-BR` or `zh-Hans`, and whisper.cpp knows only `pt`
 * and `zh` and exits on anything else (measured against whisper.cpp 1.9.5).
 */
export function whisperLanguage(tag: string): string {
  return (tag.split('-')[0] ?? tag).toLowerCase();
}

/**
 * Transcribe one audio file.
 *
 * The language is always explicit: left to auto-detect, a small model took English
 * speech for French, and a transcript in the wrong language is worse than none.
 */
export async function runWhisper(
  audioPath: string,
  language: string,
  modelPath: string,
  outputBase: string
): Promise<TranscriptSegment[]> {
  const outputPath = `${outputBase}.json`;

  try {
    await execa(
      WHISPER_BINARY,
      [
        '-m',
        modelPath,
        '-f',
        audioPath,
        '-l',
        whisperLanguage(language),
        '-oj',
        '-of',
        outputBase,
        '-np',
      ],
      { cancelSignal: currentContext().signal }
    );
    return parseWhisperJson(await readFile(outputPath, 'utf-8'));
  } catch (error) {
    if (error instanceof YouTubeError) throw error;
    throw new YouTubeError('YTDLP_FAILED', 'whisper.cpp could not transcribe this audio.', {
      nextStep: 'Check that the model file is a valid ggml model, or call check_health.',
      cause: error,
    });
  } finally {
    await rm(outputPath, { force: true });
  }
}
