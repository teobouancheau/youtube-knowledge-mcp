import { join } from 'path';
import { mkdir, readFile, writeFile, unlink } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { YouTubeError } from './errors.js';
import { TIMEOUTS, runYtDlp } from './ytdlp.js';
import { noCaptionsError } from './caption-probe.js';
import { assertLanguageTag } from './validate.js';
import { envInt } from './env.js';
import { dataDir } from './paths.js';
import {
  TRANSCRIPT_CACHE_VERSION,
  cachedTranscriptSchema,
  parseVtt,
  segmentsToText,
  type CachedTranscript,
  type TranscriptSegment,
} from './transcript.js';
import { extractVideoId, watchUrl } from './youtube-url.js';

/** Fetching a transcript from YouTube and keeping it on disk. */

const CACHE_DIR = dataDir('transcripts');

export interface TranscriptResult {
  /** The whole transcript as plain text, unchanged from previous releases. */
  transcript: string;
  /** The same content with cue timings preserved. */
  segments: TranscriptSegment[];
  language: string;
  videoId: string;
  /** True when served from the local cache rather than refetched. */
  cached: boolean;
}

export interface GetTranscriptOptions {
  language?: string;
  /** Ignore any cached copy and refetch from YouTube. */
  refresh?: boolean;
}

/** Captions rarely change, but a cache with no expiry is a cache that goes wrong. */
const TRANSCRIPT_TTL_MS = envInt('YOUTUBE_MCP_TRANSCRIPT_TTL_MS', 30 * 86_400_000, { min: 0 });

function cachePath(videoId: string, language: string): string {
  return join(CACHE_DIR, `${videoId}.${language}.json`);
}

async function readCachedTranscript(
  videoId: string,
  language: string
): Promise<CachedTranscript | undefined> {
  const path = cachePath(videoId, language);
  if (!existsSync(path)) return undefined;

  try {
    const parsed = cachedTranscriptSchema.safeParse(JSON.parse(await readFile(path, 'utf-8')));
    // Anything unreadable — an older layout, a truncated write, a hand-edit —
    // is treated as absent and refetched, rather than half-trusted.
    if (!parsed.success) return undefined;

    const cached = parsed.data;

    // A cache written by an older version holds untimed text; regenerate it
    // rather than reading it back as if it had timings.
    if (cached.version !== TRANSCRIPT_CACHE_VERSION) return undefined;

    const fetchedAt = Date.parse(cached.fetchedAt);
    if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt > TRANSCRIPT_TTL_MS) return undefined;

    return cached;
  } catch {
    return undefined;
  }
}

/** True when a usable transcript is already on disk, in any language. */
export function hasCachedTranscript(videoId: string): boolean {
  if (!existsSync(CACHE_DIR)) return false;
  return readdirSync(CACHE_DIR).some(
    (name) => name.startsWith(`${videoId}.`) && name.endsWith('.json')
  );
}

export async function getTranscript(
  urlOrId: string,
  preferredLangOrOptions: string | GetTranscriptOptions = 'en'
): Promise<TranscriptResult> {
  const options =
    typeof preferredLangOrOptions === 'string'
      ? { language: preferredLangOrOptions }
      : preferredLangOrOptions;
  const preferredLang = options.language ?? 'en';

  const videoId = extractVideoId(urlOrId);
  assertLanguageTag(preferredLang);
  const url = watchUrl(videoId);

  await mkdir(CACHE_DIR, { recursive: true });

  if (!options.refresh) {
    const cached = await readCachedTranscript(videoId, preferredLang);
    if (cached) {
      return {
        transcript: segmentsToText(cached.segments),
        segments: cached.segments,
        language: cached.language,
        videoId,
        cached: true,
      };
    }
  }

  const tempDir = join(CACHE_DIR, 'temp');
  await mkdir(tempDir, { recursive: true });
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
    await writeFile(cachePath(videoId, preferredLang), JSON.stringify(entry), 'utf-8');
    await unlink(found.file).catch(() => undefined);

    return {
      transcript: segmentsToText(segments),
      segments,
      language: found.language,
      videoId,
      cached: false,
    };
  } catch (error) {
    // Already typed and actionable — pass it through rather than flattening it
    // into a generic string, which is what the old wrapper did to every failure.
    if (error instanceof YouTubeError) throw error;
    throw new YouTubeError('YTDLP_FAILED', `Could not read the transcript for ${videoId}.`, {
      nextStep: 'Verify the video exists and has captions, or call check_health.',
      cause: error,
    });
  }
}
