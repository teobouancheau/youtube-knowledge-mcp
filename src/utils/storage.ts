import { homedir } from 'os';
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const BASE_DIR = join(homedir(), '.youtube-knowledge');
const LIBRARY_DIR = join(BASE_DIR, 'library');
const INDEX_FILE = join(BASE_DIR, 'index.json');

export interface LibraryMetadata {
  videoId: string;
  title: string;
  channel: string;
  url: string;
  tags: string[];
  dateSaved: string;
  hasTranscript: boolean;
  hasSummary: boolean;
  hasSkill: boolean;
}

export interface LibraryIndex {
  version: number;
  items: Record<string, LibraryMetadata>;
}

export interface LibraryItem extends LibraryMetadata {
  summary?: string;
  skill?: string;
}

async function ensureDirectories(): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true });
  await mkdir(LIBRARY_DIR, { recursive: true });
}

async function loadIndex(): Promise<LibraryIndex> {
  await ensureDirectories();

  if (!existsSync(INDEX_FILE)) {
    return { version: 1, items: {} };
  }

  try {
    const content = await readFile(INDEX_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (isLibraryIndex(parsed)) {
      return parsed;
    }
    return { version: 1, items: {} };
  } catch {
    return { version: 1, items: {} };
  }
}

function isLibraryIndex(value: unknown): value is LibraryIndex {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    'items' in value &&
    typeof (value as LibraryIndex).version === 'number'
  );
}

function isPartialMetadata(value: unknown): value is Partial<LibraryMetadata> {
  return typeof value === 'object' && value !== null;
}

async function saveIndex(index: LibraryIndex): Promise<void> {
  await ensureDirectories();
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
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

  const itemDir = join(LIBRARY_DIR, videoId);
  await mkdir(itemDir, { recursive: true });

  // Save content
  const filename = contentType === 'summary' ? 'summary.md' : 'skill.md';
  const filePath = join(itemDir, filename);
  await writeFile(filePath, content, 'utf-8');

  // Update metadata
  const metadataPath = join(itemDir, 'metadata.json');
  let metadata: Partial<LibraryMetadata> = {};

  if (existsSync(metadataPath)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(metadataPath, 'utf-8'));
      if (isPartialMetadata(parsed)) {
        metadata = parsed;
      }
    } catch {
      // Ignore parse errors
    }
  }

  const updatedMetadata: LibraryMetadata = {
    videoId,
    title,
    channel: channel ?? metadata.channel ?? '',
    url: url ?? metadata.url ?? `https://www.youtube.com/watch?v=${videoId}`,
    tags: [...new Set([...(metadata.tags ?? []), ...tags])],
    dateSaved: new Date().toISOString(),
    hasTranscript: metadata.hasTranscript ?? false,
    hasSummary: contentType === 'summary' ? true : (metadata.hasSummary ?? false),
    hasSkill: contentType === 'skill' ? true : (metadata.hasSkill ?? false),
  };

  await writeFile(metadataPath, JSON.stringify(updatedMetadata, null, 2), 'utf-8');

  // Update index
  const index = await loadIndex();
  index.items[videoId] = updatedMetadata;
  await saveIndex(index);

  return { path: filePath, saved: true };
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

export async function getFromLibrary(videoId: string): Promise<LibraryItem | null> {
  const index = await loadIndex();

  if (!Object.hasOwn(index.items, videoId)) {
    return null;
  }

  const metadata = index.items[videoId];
  const itemDir = join(LIBRARY_DIR, videoId);
  const item: LibraryItem = { ...metadata };

  // Load summary if exists
  const summaryPath = join(itemDir, 'summary.md');
  if (existsSync(summaryPath)) {
    item.summary = await readFile(summaryPath, 'utf-8');
  }

  // Load skill if exists
  const skillPath = join(itemDir, 'skill.md');
  if (existsSync(skillPath)) {
    item.skill = await readFile(skillPath, 'utf-8');
  }

  return item;
}

export async function deleteFromLibrary(videoId: string): Promise<boolean> {
  const index = await loadIndex();

  if (!Object.hasOwn(index.items, videoId)) {
    return false;
  }

  // Create new items object without the deleted videoId
  const { [videoId]: _removed, ...remainingItems } = index.items;
  index.items = remainingItems;
  await saveIndex(index);

  // Note: We don't delete the files, just remove from index
  // This allows recovery if needed

  return true;
}
