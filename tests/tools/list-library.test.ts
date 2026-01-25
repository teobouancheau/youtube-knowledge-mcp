import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the storage utility
vi.mock('../../src/utils/storage.js', () => ({
  listLibrary: vi.fn(),
}));

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
    const text = result.content[0].text;
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

    const text = result.content[0].text;
    expect(text).toContain('Your library is empty');
  });
});
