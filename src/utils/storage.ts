import { join } from 'path';
import { z } from 'zod';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { YouTubeError } from './errors.js';
import { hasCachedTranscript } from './youtube.js';
import { SearchIndex, type SearchResults } from './search-index.js';
import { libraryMetadataSchema, recordOfValid } from '../schemas.js';
import { readJsonFile, writeJsonAtomic } from './json-file.js';
import { dataDir } from './paths.js';
import { assertVideoId } from './validate.js';

const LIBRARY_DIR = dataDir('library');
const INDEX_FILE = dataDir('index.json');

export type LibraryMetadata = z.infer<typeof libraryMetadataSchema>;

/**
 * The library index describes a file on disk that this process wrote but does
 * not own: it survives upgrades, gets synced between machines, and is plain
 * JSON anyone can edit. It is a schema rather than an interface so that reading
 * it back validates rather than assumes.
 */
export const libraryIndexSchema = z.object({
  version: z.number(),
  items: recordOfValid(libraryMetadataSchema),
});

export type LibraryIndex = z.infer<typeof libraryIndexSchema>;

async function ensureDirectories(): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await mkdir(LIBRARY_DIR, { recursive: true });
}

async function loadIndex(): Promise<LibraryIndex> {
  await ensureDirectories();
  return (await readJsonFile(INDEX_FILE, libraryIndexSchema)) ?? { version: 1, items: {} };
}

async function saveIndex(index: LibraryIndex): Promise<void> {
  await ensureDirectories();
  await writeJsonAtomic(INDEX_FILE, index);
}

export interface SaveOptions {
  videoId: string;
  title: string;
  channel?: string;
  url?: string;
  content: string;
  contentType: 'summary' | 'skill';
  tags?: string[];
}

export async function saveToLibrary(
  options: SaveOptions
): Promise<{ path: string; saved: boolean }> {
  const { videoId, title, channel, url, content, contentType, tags = [] } = options;

  await ensureDirectories();

  const directory = itemDir(videoId);
  await mkdir(directory, { recursive: true });

  // Save content
  const filename = contentType === 'summary' ? 'summary.md' : 'skill.md';
  const filePath = join(directory, filename);
  await writeFile(filePath, content, 'utf-8');

  // Update metadata. Only the fields worth carrying forward need to survive
  // validation, so this is the metadata schema made optional field by field
  // rather than an "is an object" check that let anything through as metadata.
  const metadata: Partial<LibraryMetadata> =
    (await readJsonFile(metadataPath(videoId), libraryMetadataSchema.partial())) ?? {};

  const updatedMetadata: LibraryMetadata = {
    videoId,
    title,
    channel: channel ?? metadata.channel ?? '',
    url: url ?? metadata.url ?? `https://www.youtube.com/watch?v=${videoId}`,
    tags: [...new Set([...(metadata.tags ?? []), ...tags])],
    dateSaved: new Date().toISOString(),
    // Was hardcoded false and never updated, so the flag always lied. It now
    // reflects whether a transcript is actually on disk.
    hasTranscript: hasCachedTranscript(videoId),
    hasSummary: contentType === 'summary' ? true : (metadata.hasSummary ?? false),
    hasSkill: contentType === 'skill' ? true : (metadata.hasSkill ?? false),
  };

  await writeMetadata(updatedMetadata);

  // Update index
  const index = await loadIndex();
  index.items[videoId] = updatedMetadata;
  await saveIndex(index);

  await indexDocument(videoId, title, contentType, content);

  return { path: filePath, saved: true };
}

// -- Reading back --------------------------------------------------------
//
// The library used to be write-only: save_to_library wrote markdown that no
// tool could ever read, and list_library could filter by tag substring and
// nothing else. Everything below closes that.

export interface LibraryItem {
  metadata: LibraryMetadata;
  summary?: string;
  skill?: string;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([existing]) => existing !== key));
}

/**
 * The only place a video id becomes a path. Validated here, exactly as
 * `brainDir` validates a channel id, because a value like `../../x` would
 * otherwise write — and, on delete, recursively remove — outside the library.
 */
function itemDir(videoId: string): string {
  return join(LIBRARY_DIR, assertVideoId(videoId));
}

function metadataPath(videoId: string): string {
  return join(itemDir(videoId), 'metadata.json');
}

async function writeMetadata(metadata: LibraryMetadata): Promise<void> {
  await writeJsonAtomic(metadataPath(metadata.videoId), metadata);
}

async function readIfPresent(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  return readFile(path, 'utf-8');
}

export async function getLibraryItem(
  videoId: string,
  contentType?: 'summary' | 'skill'
): Promise<LibraryItem> {
  const index = await loadIndex();
  const metadata = index.items[videoId];

  if (!metadata) {
    throw new YouTubeError('NOT_FOUND', `Nothing saved for video ${videoId}.`, {
      nextStep: 'Call list_library to see what is saved, or save_to_library to add it.',
    });
  }

  const item: LibraryItem = { metadata };

  if (contentType === undefined || contentType === 'summary') {
    item.summary = await readIfPresent(join(itemDir(videoId), 'summary.md'));
  }
  if (contentType === undefined || contentType === 'skill') {
    item.skill = await readIfPresent(join(itemDir(videoId), 'skill.md'));
  }

  if (item.summary === undefined && item.skill === undefined) {
    throw new YouTubeError('NOT_FOUND', `No ${contentType ?? 'content'} saved for ${videoId}.`, {
      nextStep: 'Call list_library to see which content types exist for this video.',
    });
  }

  return item;
}

export async function deleteLibraryItem(
  videoId: string,
  contentType?: 'summary' | 'skill'
): Promise<{ deleted: string[] }> {
  const index = await loadIndex();
  const metadata = index.items[videoId];

  if (!metadata) {
    throw new YouTubeError('NOT_FOUND', `Nothing saved for video ${videoId}.`, {
      nextStep: 'Call list_library to see what is saved.',
    });
  }

  // Deleting one content type leaves the other in place; deleting with no type
  // removes the whole entry.
  if (contentType === undefined) {
    await rm(itemDir(videoId), { recursive: true, force: true });
    index.items = withoutKey(index.items, videoId);
    await saveIndex(index);
    await removeFromIndex(videoId);
    return { deleted: ['summary', 'skill', 'metadata'] };
  }

  const filename = contentType === 'summary' ? 'summary.md' : 'skill.md';
  await rm(join(itemDir(videoId), filename), { force: true });

  const updated: LibraryMetadata = {
    ...metadata,
    hasSummary: contentType === 'summary' ? false : metadata.hasSummary,
    hasSkill: contentType === 'skill' ? false : metadata.hasSkill,
  };

  if (!updated.hasSummary && !updated.hasSkill) {
    await rm(itemDir(videoId), { recursive: true, force: true });
    index.items = withoutKey(index.items, videoId);
  } else {
    index.items[videoId] = updated;
    await writeMetadata(updated);
  }

  await saveIndex(index);
  await removeFromIndex(videoId, contentType);
  return { deleted: [contentType] };
}

export async function updateLibraryTags(
  videoId: string,
  changes: { add?: string[]; remove?: string[]; replace?: string[] }
): Promise<LibraryMetadata> {
  const index = await loadIndex();
  const metadata = index.items[videoId];

  if (!metadata) {
    throw new YouTubeError('NOT_FOUND', `Nothing saved for video ${videoId}.`, {
      nextStep: 'Call list_library to see what is saved.',
    });
  }

  const removals = new Set((changes.remove ?? []).map((tag) => tag.toLowerCase()));
  const base = changes.replace ?? metadata.tags;
  const tags = [...new Set([...base, ...(changes.add ?? [])])].filter(
    (tag) => !removals.has(tag.toLowerCase())
  );

  const updated: LibraryMetadata = { ...metadata, tags };
  index.items[videoId] = updated;
  await saveIndex(index);
  await writeMetadata(updated);

  return updated;
}

/** Every tag in the library, for argument completion. */
export async function listTags(): Promise<string[]> {
  const index = await loadIndex();
  const tags = new Set<string>();
  for (const item of Object.values(index.items)) {
    for (const tag of item.tags) tags.add(tag);
  }
  return [...tags].sort();
}

// -- Full-text search ----------------------------------------------------

const INDEX_SEARCH_FILE = dataDir('search-index.json');

async function loadSearchIndex(): Promise<SearchIndex> {
  await ensureDirectories();
  // A corrupt index is a cache, not data: `fromJSON` rebuilds from what it can
  // read rather than failing, and an unreadable file yields an empty index.
  return SearchIndex.fromJSON(await readJsonFile(INDEX_SEARCH_FILE, z.unknown()));
}

async function persistSearchIndex(index: SearchIndex): Promise<void> {
  // Not pretty-printed: indentation is most of the bytes in an index nobody reads.
  await writeJsonAtomic(INDEX_SEARCH_FILE, index.toJSON(), { pretty: false });
}

async function indexDocument(
  videoId: string,
  title: string,
  kind: string,
  text: string
): Promise<void> {
  const index = await loadSearchIndex();
  index.add({ id: `${videoId}:${kind}`, videoId, title, kind, text });
  await persistSearchIndex(index);
}

async function removeFromIndex(videoId: string, kind?: string): Promise<void> {
  const index = await loadSearchIndex();
  if (kind === undefined) {
    for (const type of ['summary', 'skill']) index.remove(`${videoId}:${type}`);
  } else {
    index.remove(`${videoId}:${kind}`);
  }
  await persistSearchIndex(index);
}

export async function searchLibrary(query: string, limit = 10, offset = 0): Promise<SearchResults> {
  const index = await loadSearchIndex();
  return index.search(query, limit, offset);
}

/** Rebuild the index from what is actually on disk. */
export async function rebuildSearchIndex(): Promise<{ documents: number }> {
  const libraryIndex = await loadIndex();
  const index = new SearchIndex();

  for (const metadata of Object.values(libraryIndex.items)) {
    for (const kind of ['summary', 'skill'] as const) {
      const text = await readIfPresent(join(itemDir(metadata.videoId), `${kind}.md`));
      if (text !== undefined) {
        index.add({
          id: `${metadata.videoId}:${kind}`,
          videoId: metadata.videoId,
          title: metadata.title,
          kind,
          text,
        });
      }
    }
  }

  await persistSearchIndex(index);
  return { documents: index.size };
}

export async function listLibrary(filter?: { tag?: string }): Promise<LibraryMetadata[]> {
  const index = await loadIndex();
  let items = Object.values(index.items);

  if (filter?.tag) {
    const tagLower = filter.tag.toLowerCase();
    items = items.filter((item) => item.tags.some((t) => t.toLowerCase().includes(tagLower)));
  }

  // Sort by date saved (most recent first)
  items.sort((a, b) => new Date(b.dateSaved).getTime() - new Date(a.dateSaved).getTime());

  return items;
}
