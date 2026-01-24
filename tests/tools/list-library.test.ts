import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the storage utility
vi.mock('../../src/utils/storage.js', () => ({
  listLibrary: vi.fn(),
}));

interface LibraryOutputItem {
  video_id: string;
  title: string;
  channel: string;
  tags: string[];
  date_saved: string;
  has_summary: boolean;
  has_skill: boolean;
  url: string;
}

interface ListLibraryOutput {
  count: number;
  items: LibraryOutputItem[];
}

describe('list-library tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return library items', async () => {
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
    const parsed = JSON.parse(result.content[0].text) as ListLibraryOutput;
    expect(parsed.count).toBe(1);
    expect(parsed.items[0].video_id).toBe('vid1');
  });

  it('should filter by tag', async () => {
    const { listLibrary } = await import('../../src/utils/storage.js');
    vi.mocked(listLibrary).mockResolvedValue([]);

    const { listLibraryHandler } = await import('../../src/tools/list-library.js');
    await listLibraryHandler({ tag: 'programming' });

    expect(listLibrary).toHaveBeenCalledWith({ tag: 'programming' });
  });

  it('should return empty list when library is empty', async () => {
    const { listLibrary } = await import('../../src/utils/storage.js');
    vi.mocked(listLibrary).mockResolvedValue([]);

    const { listLibraryHandler } = await import('../../src/tools/list-library.js');
    const result = await listLibraryHandler({});

    const parsed = JSON.parse(result.content[0].text) as ListLibraryOutput;
    expect(parsed.count).toBe(0);
    expect(parsed.items).toEqual([]);
  });
});
