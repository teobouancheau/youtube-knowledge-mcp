import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { brainChunkFileSchema, type BrainChunk, type BrainPassage } from '../brain-schemas.js';
import { brainDir, chunksPath } from './brain-paths.js';
import { readJsonFile, writeJsonAtomic } from './json-file.js';
import { SearchIndex } from './search-index.js';
import { deepLink, formatTimestamp } from './transcript.js';

/**
 * The searchable half of a brain: the passages, and a BM25 index over them.
 *
 * The passages are the only thing persisted. An index file alongside them would
 * hold a second copy of every word — the serialised index carries the text it
 * scored — and would then be free to disagree with them. It is built in memory
 * on first use instead and kept until the passages change: measured at 1.5s for
 * a corpus at this brain's 100,000-passage ceiling, once, against a class of
 * bugs forever. A search over that corpus then costs 73ms.
 *
 * Retrieval is the only way a corpus reaches a model. That ceiling is 81MB of
 * transcript, so there is no "give me everything" path here: `readChunks`
 * exists for statistics and rebuilding, not for answering.
 */

export const BRAIN_CHUNK_FILE_VERSION = 1;

interface Corpus {
  index: SearchIndex;
  byId: Map<string, BrainChunk>;
}

interface CachedCorpus {
  corpus: Corpus;
  mtimeMs: number;
}

/**
 * Rebuilding the index on every query would re-read and re-tokenise the whole
 * corpus each time. The passage file's modification time decides when the
 * cached copy is wrong, so a build running in another process is picked up
 * without any coordination between the two.
 */
const cache = new Map<string, CachedCorpus>();

export function forgetBrainCorpus(channelId: string): void {
  cache.delete(channelId);
}

export async function readChunks(channelId: string): Promise<BrainChunk[]> {
  const file = await readJsonFile(chunksPath(channelId), brainChunkFileSchema);
  return file?.chunks ?? [];
}

export async function writeChunks(channelId: string, chunks: BrainChunk[]): Promise<void> {
  await mkdir(brainDir(channelId), { recursive: true });
  // Not pretty-printed: indentation would be a fifth of a file nobody reads.
  await writeJsonAtomic(
    chunksPath(channelId),
    { version: BRAIN_CHUNK_FILE_VERSION, chunks },
    { pretty: false }
  );
  forgetBrainCorpus(channelId);
}

export interface BrainSearchResults {
  passages: BrainPassage[];
  /** Passages matching the query, not passages returned. */
  total: number;
}

/** Passages ranked against the query, each with the link that opens it. */
export async function searchBrain(
  channelId: string,
  query: string,
  limit: number,
  offset = 0
): Promise<BrainSearchResults> {
  const { index, byId } = await corpusOf(channelId);
  const { hits, total } = index.search(query, limit, offset);

  const passages = hits.flatMap((hit) => {
    const chunk = byId.get(hit.id);
    if (chunk === undefined) return [];

    return [
      {
        videoId: chunk.videoId,
        title: chunk.title,
        startSeconds: chunk.startSeconds,
        startFormatted: formatTimestamp(chunk.startSeconds),
        endSeconds: chunk.endSeconds,
        score: hit.score,
        text: chunk.text,
        url: deepLink(chunk.videoId, chunk.startSeconds),
      },
    ];
  });

  return { passages, total };
}

async function corpusOf(channelId: string): Promise<Corpus> {
  const path = chunksPath(channelId);
  if (!existsSync(path)) return emptyCorpus();

  const { mtimeMs } = await stat(path);
  const cached = cache.get(channelId);
  if (cached?.mtimeMs === mtimeMs) return cached.corpus;

  const corpus = buildCorpus(await readChunks(channelId));
  cache.set(channelId, { corpus, mtimeMs });
  return corpus;
}

function emptyCorpus(): Corpus {
  return { index: new SearchIndex(), byId: new Map() };
}

/**
 * The shared index is used unchanged: a passage already has an id, a video, a
 * title and text, which is everything BM25 scores on. `kind` distinguishes
 * these rows from the library's summaries and skills.
 */
function buildCorpus(chunks: BrainChunk[]): Corpus {
  const corpus = emptyCorpus();

  for (const chunk of chunks) {
    corpus.index.add({
      id: chunk.id,
      videoId: chunk.videoId,
      title: chunk.title,
      kind: 'chunk',
      text: chunk.text,
    });
    corpus.byId.set(chunk.id, chunk);
  }

  return corpus;
}
