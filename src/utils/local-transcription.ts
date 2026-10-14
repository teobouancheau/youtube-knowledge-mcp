import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { YouTubeError } from './errors.js';
import { ensurePrivateDir } from './paths.js';
import { requireFfmpeg } from './preflight.js';
import {
  TRANSCRIPT_DIR,
  asrPath,
  readTranscriptFile,
  writeTranscriptFile,
} from './transcript-files.js';
import { resultFromEntry, type TranscriptResult } from './transcript-cache.js';
import { TRANSCRIPT_CACHE_VERSION, segmentsToText, type CachedTranscript } from './transcript.js';
import { assertLanguageTag } from './validate.js';
import { requireWhisper, runWhisper } from './whisper.js';
import { extractVideoId, watchUrl } from './youtube-url.js';
import { TIMEOUTS, runYtDlp } from './ytdlp.js';

/**
 * Turning a video's audio into a transcript when YouTube has no captions for it.
 *
 * Slow and CPU-heavy by nature, so it only ever runs when asked for, and what it
 * produces is kept: a transcription is deterministic and takes minutes to redo.
 */

export interface LocalTranscriptionOptions {
  language?: string;
  /** Transcribe again even if a kept transcription exists. */
  refresh?: boolean;
}

/** What yt-dlp is told to leave behind: whisper reads 16 kHz mono, so make it that size. */
const AUDIO_ARGS = [
  '-f',
  'bestaudio',
  '-x',
  '--audio-format',
  'wav',
  '--postprocessor-args',
  'ExtractAudio:-ar 16000 -ac 1',
  '--no-playlist',
];

export async function transcribeLocally(
  urlOrId: string,
  options: LocalTranscriptionOptions
): Promise<TranscriptResult> {
  const language = options.language ?? 'en';
  const videoId = extractVideoId(urlOrId);
  assertLanguageTag(language);

  if (options.refresh !== true) {
    const kept = await readTranscriptFile(asrPath(videoId, language), { expires: false });
    if (kept) return resultFromEntry(kept, videoId, 'local-asr');
  }

  // Cheap local checks first: a missing tool should fail now, not after the audio
  // has been downloaded.
  await requireFfmpeg('Local transcription');
  const modelPath = await requireWhisper('Local transcription');

  const tempDir = join(TRANSCRIPT_DIR, 'temp');
  await ensurePrivateDir(tempDir);
  // A folder of its own for this call: yt-dlp leaves the original download and `.part`
  // files beside the wav it makes, and two calls for one video must not share, then
  // delete, each other's audio. The whole folder goes when this call does.
  const workDir = await mkdtemp(join(tempDir, `${videoId}-`));
  const audioBase = join(workDir, 'audio');
  const audioPath = `${audioBase}.wav`;

  try {
    await runYtDlp([...AUDIO_ARGS, '-o', `${audioBase}.%(ext)s`], {
      label: 'transcribe_video',
      timeoutMs: TIMEOUTS.download,
      retry: false,
      target: watchUrl(videoId),
    });

    if (!existsSync(audioPath)) {
      throw new YouTubeError('YTDLP_FAILED', 'yt-dlp did not produce the audio to transcribe.', {
        nextStep: 'Check the video is playable, or call check_health.',
      });
    }

    const segments = await runWhisper(audioPath, language, modelPath, join(workDir, 'whisper'));

    if (segments.length === 0) {
      throw new YouTubeError('NOT_FOUND', 'No speech was found in this video’s audio.', {
        nextStep:
          'The audio may be music or silence, or the model may not know this language. Try a larger model or another language.',
      });
    }

    const entry: CachedTranscript = {
      version: TRANSCRIPT_CACHE_VERSION,
      videoId,
      language,
      fetchedAt: new Date().toISOString(),
      segments,
    };
    await writeTranscriptFile(asrPath(videoId, language), entry);

    return {
      transcript: segmentsToText(segments),
      segments,
      language,
      videoId,
      cached: false,
      source: 'local-asr',
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
