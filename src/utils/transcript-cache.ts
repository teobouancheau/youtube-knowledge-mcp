import { join } from 'path';
import { readFile, unlink } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { YouTubeError } from './errors.js';
import { TIMEOUTS, runYtDlp } from './ytdlp.js';
import { noCaptionsError } from './caption-probe.js';
import { assertLanguageTag } from './validate.js';
import { ensurePrivateDir } from './paths.js';
import {
  TRANSCRIPT_DIR,
  asrPath,
  captionsPath,
  readTranscriptFile,
  writeTranscriptFile,
} from './transcript-files.js';
import {
  TRANSCRIPT_CACHE_VERSION,
  parseVtt,
  segmentsToText,
  type CachedTranscript,
  type TranscriptSegment,
  type TranscriptSource,
} from './transcript.js';
import { extractVideoId, watchUrl } from './youtube-url.js';

/** Fetching a transcript from YouTube and keeping it on disk. */

export interface TranscriptResult {
  /** The whole transcript as plain text, unchanged from previous releases. */
  transcript: string;
  /** The same content with cue timings preserved. */
  segments: TranscriptSegment[];
  language: string;
  videoId: string;
  /** True when served from the local cache rather than refetched. */
  cached: boolean;
  /** Where the words came from: YouTube's captions, or a local transcription of the audio. */
  source: TranscriptSource;
}

export interface GetTranscriptOptions {
  language?: string;
  /** Ignore any cached copy and refetch from YouTube. */
  refresh?: boolean;
}

/** True when a usable transcript is already on disk, in any language. */
export function hasCachedTranscript(videoId: string): boolean {
  if (!existsSync(TRANSCRIPT_DIR)) return false;
  return readdirSync(TRANSCRIPT_DIR).some(
    (name) => name.startsWith(`${videoId}.`) && name.endsWith('.json')
  );
}

export function resultFromEntry(
  entry: CachedTranscript,
  videoId: string,
  source: TranscriptSource
): TranscriptResult {
  return {
    transcript: segmentsToText(entry.segments),
    segments: entry.segments,
    language: entry.language,
    videoId,
    cached: true,
    source,
  };
}

export async function getTranscript(
  urlOrId: string,
  options: GetTranscriptOptions = {}
): Promise<TranscriptResult> {
  const preferredLang = options.language ?? 'en';

  const videoId = extractVideoId(urlOrId);
  assertLanguageTag(preferredLang);
  const url = watchUrl(videoId);

  await ensurePrivateDir(TRANSCRIPT_DIR);

  if (!options.refresh) {
    const cached = await readTranscriptFile(captionsPath(videoId, preferredLang), {
      expires: true,
    });
    if (cached) return resultFromEntry(cached, videoId, 'captions');
  }

  const tempDir = join(TRANSCRIPT_DIR, 'temp');
  await ensurePrivateDir(tempDir);
  const outputTemplate = join(tempDir, videoId);

  try {
    await runYtDlp(
      [
        '--skip-download',
        '--write-auto-sub',
        '--write-sub',
        '--sub-lang',
        `${preferredLang},${preferredLang}-orig`,
        '--sub-format',
        'vtt',
        '--convert-subs',
        'vtt',
        '-o',
        outputTemplate,
      ],
      { label: 'get_transcript', timeoutMs: TIMEOUTS.transcript, target: url }
    );

    const candidates = [
      { file: `${outputTemplate}.${preferredLang}.vtt`, language: preferredLang },
      {
        file: `${outputTemplate}.${preferredLang}-orig.vtt`,
        language: `${preferredLang} (auto-generated)`,
      },
      { file: `${outputTemplate}.en.vtt`, language: 'en' },
    ];

    const found = candidates.find((candidate) => existsSync(candidate.file));
    if (!found) throw await noCaptionsError(url, preferredLang);

    const segments = parseVtt(await readFile(found.file, 'utf-8'));
    if (segments.length === 0) throw await noCaptionsError(url, preferredLang);

    const entry: CachedTranscript = {
      version: TRANSCRIPT_CACHE_VERSION,
      videoId,
      language: found.language,
      fetchedAt: new Date().toISOString(),
      segments,
    };
    await writeTranscriptFile(captionsPath(videoId, preferredLang), entry);
    await unlink(found.file).catch(() => undefined);

    return {
      transcript: segmentsToText(segments),
      segments,
      language: found.language,
      videoId,
      cached: false,
      source: 'captions',
    };
  } catch (error) {
    if (error instanceof YouTubeError && error.code === 'NO_CAPTIONS') {
      // A transcription made locally stands in only when the video has no captions
      // at all, so real captions are never displaced by a machine's guess.
      const heard = await readTranscriptFile(asrPath(videoId, preferredLang), { expires: false });
      if (heard) return resultFromEntry(heard, videoId, 'local-asr');
    }

    // Already typed and actionable — pass it through rather than flattening it
    // into a generic string, which is what the old wrapper did to every failure.
    if (error instanceof YouTubeError) throw error;
    throw new YouTubeError('YTDLP_FAILED', `Could not read the transcript for ${videoId}.`, {
      nextStep: 'Verify the video exists and has captions, or call check_health.',
      cause: error,
    });
  }
}
