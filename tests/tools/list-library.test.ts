import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf } from '../helpers.js';

// Mock the storage utility
vi.mock('../../src/utils/storage.js', () => ({
  listLibrary: vi.fn(),
}));

import { listLibrary } from '../../src/utils/storage.js';
import { listLibraryHandler } from '../../src/tools/list-library.js';

describe('list-library tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return library items as human-readable text', async () => {
    const { listLibrary } = await import('../../src/utils/storage.js');
    vi.mocked(listLibrary).mockResolvedValue([
      {
        videoId: 'vid1',
        title: 'Video 1',
        channel: 'Channel 1',
        url: 'https://youtube.com/watch?v=vid1',
        tags: ['tag1'],
        dateSaved: '2024-01-01T00:00:00Z',
        hasTranscript: false,
        hasSummary: true,
        hasSkill: false,
      },
    ]);

    const { listLibraryHandler } = await import('../../src/tools/list-library.js');
    const result = await listLibraryHandler({});

    expect(result.content).toHaveLength(1);
    const text = textOf(result);
    expect(text).toContain('1 item in library');
    expect(text).toContain('Video 1');
    expect(text).toContain('by Channel 1');
    expect(text).toContain('tags: tag1');
  });

  it('should filter by tag', async () => {
    const { listLibrary } = await import('../../src/utils/storage.js');
    vi.mocked(listLibrary).mockResolvedValue([]);

    const { listLibraryHandler } = await import('../../src/tools/list-library.js');
    await listLibraryHandler({ tag: 'programming' });

    expect(listLibrary).toHaveBeenCalledWith({ tag: 'programming' });
  });

  it('should return empty message when library is empty', async () => {
    const { listLibrary } = await import('../../src/utils/storage.js');
    vi.mocked(listLibrary).mockResolvedValue([]);

    const { listLibraryHandler } = await import('../../src/tools/list-library.js');
    const result = await listLibraryHandler({});

    const text = textOf(result);
    expect(text).toContain('Your library is empty');
  });
});

describe('listLibraryHandler rendering', () => {
  const ITEM = {
    videoId: 'v1',
    title: 'A Talk',
    channel: 'Chan',
    url: 'https://www.youtube.com/watch?v=v1',
    tags: ['systems'],
    dateSaved: '2024-01-01',
    hasTranscript: false,
    hasSummary: true,
    hasSkill: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says so plainly when nothing is saved', async () => {
    vi.mocked(listLibrary).mockResolvedValue([]);

    expect(textOf(await listLibraryHandler({}))).toContain('Your library is empty.');
  });

  it('lists each item with its content types, channel and tags', async () => {
    vi.mocked(listLibrary).mockResolvedValue([ITEM]);

    const text = textOf(await listLibraryHandler({}));

    expect(text).toContain('1 item in library');
    expect(text).toContain('1. A Talk');
    expect(text).toContain('by Chan');
    expect(text).toContain('summary, skill · saved 2024-01-01');
    expect(text).toContain('tags: systems');
  });

  it('omits the channel and tag lines when there are none', async () => {
    vi.mocked(listLibrary).mockResolvedValue([{ ...ITEM, channel: '', tags: [] }]);

    const text = textOf(await listLibraryHandler({}));

    expect(text).not.toContain('by ');
    expect(text).not.toContain('tags:');
  });

  it('names the tag it filtered on', async () => {
    vi.mocked(listLibrary).mockResolvedValue([ITEM]);

    expect(textOf(await listLibraryHandler({ tag: 'systems' }))).toContain(
      '1 item matching "systems"'
    );
  });

  it('pluralises the count', async () => {
    vi.mocked(listLibrary).mockResolvedValue([ITEM, { ...ITEM, videoId: 'v2' }]);

    expect(textOf(await listLibraryHandler({}))).toContain('2 items in library');
  });

  it('lists only the content types an item actually has', async () => {
    vi.mocked(listLibrary).mockResolvedValue([{ ...ITEM, hasSkill: false }]);

    expect(textOf(await listLibraryHandler({}))).toContain('summary · saved');
  });
});
