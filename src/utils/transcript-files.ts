import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { envInt } from './env.js';
import { writeJsonAtomic } from './json-file.js';
import { dataDir } from './paths.js';
import {
  TRANSCRIPT_CACHE_VERSION,
  cachedTranscriptSchema,
  type CachedTranscript,
} from './transcript.js';

/**
 * Transcripts on disk: where they live and how they are read back.
 *
 * Captions and local transcriptions sit side by side but never overwrite each other:
 * `<id>.<lang>.json` holds what YouTube's captions said, `<id>.<lang>.asr.json` what
 * whisper heard. Real captions are always preferred, so a machine transcription can
 * never replace the better source.
 */

export const TRANSCRIPT_DIR = dataDir('transcripts');

/** Captions rarely change, but a cache with no expiry is a cache that goes wrong. */
const MS_PER_DAY = 86_400_000;
const DEFAULT_TRANSCRIPT_TTL_DAYS = 30;
const TRANSCRIPT_TTL_MS = envInt(
  'YOUTUBE_MCP_TRANSCRIPT_TTL_MS',
  DEFAULT_TRANSCRIPT_TTL_DAYS * MS_PER_DAY,
  { min: 0 }
);

export function captionsPath(videoId: string, language: string): string {
  return join(TRANSCRIPT_DIR, `${videoId}.${language}.json`);
}

export function asrPath(videoId: string, language: string): string {
  return join(TRANSCRIPT_DIR, `${videoId}.${language}.asr.json`);
}

/**
 * A transcript read back from `path`, or undefined when there is nothing usable.
 *
 * Anything unreadable — an older layout, a truncated write, a hand-edit — counts as
 * absent rather than half-trusted. Captions expire; a local transcription does not,
 * because it is deterministic and costs minutes to redo.
 */
export async function readTranscriptFile(
  path: string,
  options: { expires: boolean }
): Promise<CachedTranscript | undefined> {
  if (!existsSync(path)) return undefined;

  try {
    const parsed = cachedTranscriptSchema.safeParse(JSON.parse(await readFile(path, 'utf-8')));
    if (!parsed.success) return undefined;

    const cached = parsed.data;

    // A cache written by an older version holds untimed text; regenerate it
    // rather than reading it back as if it had timings.
    if (cached.version !== TRANSCRIPT_CACHE_VERSION) return undefined;

    if (options.expires) {
      const fetchedAt = Date.parse(cached.fetchedAt);
      if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt > TRANSCRIPT_TTL_MS) {
        return undefined;
      }
    }

    return cached;
  } catch {
    return undefined;
  }
}

export async function writeTranscriptFile(path: string, entry: CachedTranscript): Promise<void> {
  await writeJsonAtomic(path, entry, { pretty: false });
}
