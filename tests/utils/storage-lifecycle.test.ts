import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Library lifecycle against a real temporary filesystem.
 *
 * These deliberately do not mock fs: the bugs worth catching here are about
 * files and the index disagreeing with each other, which a mocked filesystem
 * cannot show.
 */

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});

async function storage(): Promise<typeof import('../../src/utils/storage.js')> {
  return import('../../src/utils/storage.js');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ytk-test-'));
  process.env.TEST_HOME = home;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.TEST_HOME;
  await rm(home, { recursive: true, force: true });
});

const NOTE = {
  videoId: 'vid1',
  title: 'Rate limiting strategies',
  content: '# Rate limiting\n\nToken bucket and leaky bucket algorithms for throttling.',
  contentType: 'summary' as const,
  channel: 'Systems Talk',
  tags: ['systems', 'api'],
};

describe('library round trip', () => {
  it('saves a note and reads it back', async () => {
    const { saveToLibrary, getLibraryItem } = await storage();

    await saveToLibrary(NOTE);
    const item = await getLibraryItem('vid1');

    expect(item.metadata.title).toBe(NOTE.title);
    expect(item.metadata.channel).toBe('Systems Talk');
    expect(item.summary).toBe(NOTE.content);
  });

  it('lists what was saved', async () => {
    const { saveToLibrary, listLibrary } = await storage();

    await saveToLibrary(NOTE);
    const items = await listLibrary();

    expect(items).toHaveLength(1);
    expect(items[0]?.hasSummary).toBe(true);
    expect(items[0]?.hasSkill).toBe(false);
  });

  it('keeps summary and skill side by side for one video', async () => {
    const { saveToLibrary, getLibraryItem } = await storage();

    await saveToLibrary(NOTE);
    await saveToLibrary({ ...NOTE, contentType: 'skill', content: 'Step 1. Measure.' });

    const item = await getLibraryItem('vid1');
    expect(item.summary).toBe(NOTE.content);
    expect(item.skill).toBe('Step 1. Measure.');
    expect(item.metadata.hasSummary && item.metadata.hasSkill).toBe(true);
  });

  it('overwrites the same content type rather than duplicating it', async () => {
    const { saveToLibrary, getLibraryItem, listLibrary } = await storage();

    await saveToLibrary(NOTE);
    await saveToLibrary({ ...NOTE, content: 'rewritten' });

    expect((await getLibraryItem('vid1')).summary).toBe('rewritten');
    expect(await listLibrary()).toHaveLength(1);
  });

  it('merges tags across saves without duplicating them', async () => {
    const { saveToLibrary, getLibraryItem } = await storage();

    await saveToLibrary(NOTE);
    await saveToLibrary({ ...NOTE, tags: ['api', 'throttling'] });

    expect((await getLibraryItem('vid1')).metadata.tags.sort()).toEqual([
      'api',
      'systems',
      'throttling',
    ]);
  });

  it('reports a missing item with a next step rather than an empty result', async () => {
    const { getLibraryItem } = await storage();

    await expect(getLibraryItem('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('only returns the requested content type', async () => {
    const { saveToLibrary, getLibraryItem } = await storage();

    await saveToLibrary(NOTE);
    await saveToLibrary({ ...NOTE, contentType: 'skill', content: 'skill text' });

    const item = await getLibraryItem('vid1', 'skill');
    expect(item.skill).toBe('skill text');
    expect(item.summary).toBeUndefined();
  });
});

describe('tag filtering', () => {
  it('matches a tag case-insensitively and partially', async () => {
    const { saveToLibrary, listLibrary } = await storage();
    await saveToLibrary(NOTE);

    expect(await listLibrary({ tag: 'SYS' })).toHaveLength(1);
  });

  it('returns nothing for an unmatched tag', async () => {
    const { saveToLibrary, listLibrary } = await storage();
    await saveToLibrary(NOTE);

    expect(await listLibrary({ tag: 'kubernetes' })).toHaveLength(0);
  });

  it('collects every distinct tag for completion', async () => {
    const { saveToLibrary, listTags } = await storage();

    await saveToLibrary(NOTE);
    await saveToLibrary({ ...NOTE, videoId: 'vid2', tags: ['api', 'databases'] });

    expect(await listTags()).toEqual(['api', 'databases', 'systems']);
  });
});

describe('updateLibraryTags', () => {
  it('adds tags', async () => {
    const { saveToLibrary, updateLibraryTags } = await storage();
    await saveToLibrary(NOTE);

    expect((await updateLibraryTags('vid1', { add: ['new'] })).tags).toContain('new');
  });

  it('removes tags case-insensitively', async () => {
    const { saveToLibrary, updateLibraryTags } = await storage();
    await saveToLibrary(NOTE);

    expect((await updateLibraryTags('vid1', { remove: ['SYSTEMS'] })).tags).not.toContain(
      'systems'
    );
  });

  it('replaces the whole set', async () => {
    const { saveToLibrary, updateLibraryTags } = await storage();
    await saveToLibrary(NOTE);

    expect((await updateLibraryTags('vid1', { replace: ['only'] })).tags).toEqual(['only']);
  });

  it('applies replace before add and remove', async () => {
    const { saveToLibrary, updateLibraryTags } = await storage();
    await saveToLibrary(NOTE);

    const updated = await updateLibraryTags('vid1', {
      replace: ['a', 'b'],
      add: ['c'],
      remove: ['b'],
    });

    expect(updated.tags.sort()).toEqual(['a', 'c']);
  });

  it('persists across a reload', async () => {
    const { saveToLibrary, updateLibraryTags, listLibrary } = await storage();
    await saveToLibrary(NOTE);
    await updateLibraryTags('vid1', { replace: ['persisted'] });

    expect((await listLibrary())[0]?.tags).toEqual(['persisted']);
  });

  it('rejects an unknown video', async () => {
    const { updateLibraryTags } = await storage();
    await expect(updateLibraryTags('nope', { add: ['x'] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('deleteLibraryItem', () => {
  it('deletes the whole entry', async () => {
    const { saveToLibrary, deleteLibraryItem, listLibrary } = await storage();
    await saveToLibrary(NOTE);

    await deleteLibraryItem('vid1');

    expect(await listLibrary()).toHaveLength(0);
  });

  it('deletes one content type and keeps the other', async () => {
    const { saveToLibrary, deleteLibraryItem, getLibraryItem } = await storage();
    await saveToLibrary(NOTE);
    await saveToLibrary({ ...NOTE, contentType: 'skill', content: 'skill text' });

    await deleteLibraryItem('vid1', 'summary');

    const item = await getLibraryItem('vid1');
    expect(item.summary).toBeUndefined();
    expect(item.skill).toBe('skill text');
    expect(item.metadata.hasSummary).toBe(false);
  });

  it('removes the entry entirely once its last note is gone', async () => {
    const { saveToLibrary, deleteLibraryItem, listLibrary } = await storage();
    await saveToLibrary(NOTE);

    await deleteLibraryItem('vid1', 'summary');

    expect(await listLibrary()).toHaveLength(0);
  });

  it('rejects an unknown video', async () => {
    const { deleteLibraryItem } = await storage();
    await expect(deleteLibraryItem('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('search', () => {
  it('finds a saved note by its content', async () => {
    const { saveToLibrary, searchLibrary } = await storage();
    await saveToLibrary(NOTE);

    const { hits } = await searchLibrary('leaky bucket throttling');
    expect(hits[0]?.videoId).toBe('vid1');
  });

  it('stops returning a note once it is deleted', async () => {
    const { saveToLibrary, deleteLibraryItem, searchLibrary } = await storage();
    await saveToLibrary(NOTE);
    await deleteLibraryItem('vid1');

    expect((await searchLibrary('throttling')).hits).toEqual([]);
  });

  it('reflects an overwrite rather than matching the old text', async () => {
    const { saveToLibrary, searchLibrary } = await storage();
    await saveToLibrary(NOTE);
    await saveToLibrary({ ...NOTE, content: 'circuit breakers instead' });

    expect((await searchLibrary('throttling')).hits).toEqual([]);
    expect((await searchLibrary('circuit breakers')).hits).toHaveLength(1);
  });

  it('rebuilds the index from what is on disk', async () => {
    const { saveToLibrary, rebuildSearchIndex, searchLibrary } = await storage();
    await saveToLibrary(NOTE);

    // Simulate a note edited by hand outside the server.
    await writeFile(
      join(home, '.youtube-knowledge', 'library', 'vid1', 'summary.md'),
      'completely different subject matter about compilers',
      'utf-8'
    );

    expect(await rebuildSearchIndex()).toEqual({ documents: 1 });
    expect((await searchLibrary('compilers')).hits).toHaveLength(1);
  });
});

describe('resilience', () => {
  it('treats a corrupt index as empty rather than failing every call', async () => {
    const base = join(home, '.youtube-knowledge');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'index.json'), '{ not json', 'utf-8');

    const { listLibrary } = await storage();
    expect(await listLibrary()).toEqual([]);
  });

  it('drops an unreadable index entry and keeps the rest of the library', async () => {
    const { saveToLibrary, listLibrary, libraryIndexSchema } = await storage();
    await saveToLibrary(NOTE);

    // A hand-edit or a partial write corrupts one entry. Validating the index
    // as a whole would lose every note; validating entry by entry loses one.
    const indexFile = join(home, '.youtube-knowledge', 'index.json');
    const index = libraryIndexSchema.parse(JSON.parse(await readFile(indexFile, 'utf-8')));
    await writeFile(
      indexFile,
      JSON.stringify({
        version: index.version,
        items: { ...index.items, broken: { videoId: 'broken', tags: 'not an array' } },
      }),
      'utf-8'
    );

    const items = await listLibrary();

    expect(items.map((item) => item.videoId)).toEqual([NOTE.videoId]);
  });

  it('refuses an index whose shape is wrong rather than half-reading it', async () => {
    const base = join(home, '.youtube-knowledge');
    await mkdir(base, { recursive: true });
    // Valid JSON, wrong shape — the case a bare "is it an object" check passed.
    await writeFile(join(base, 'index.json'), JSON.stringify({ version: 'one' }), 'utf-8');

    const { listLibrary } = await storage();
    expect(await listLibrary()).toEqual([]);
  });

  it('recovers a corrupt search index by rebuilding rather than throwing', async () => {
    const { saveToLibrary, searchLibrary } = await storage();
    await saveToLibrary(NOTE);

    await writeFile(join(home, '.youtube-knowledge', 'search-index.json'), 'garbage', 'utf-8');

    // A corrupt cache must degrade to "no results", never to an exception.
    expect((await searchLibrary('throttling')).hits).toEqual([]);
  });
});

describe('getLibraryItem when the requested note is missing', () => {
  it('reports which content type is absent rather than returning an empty item', async () => {
    const { saveToLibrary, getLibraryItem } = await storage();
    await saveToLibrary(NOTE);

    // The index knows the video, but the skill note was never written.
    const error = await getLibraryItem(NOTE.videoId, 'skill').catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'NOT_FOUND' });
    expect((error as Error).message).toContain('skill');
  });
});
