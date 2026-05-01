import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/youtube.js', () => ({
  searchVideos: vi.fn(),
}));

describe('search-videos tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return search results as formatted text', async () => {
    const { searchVideos } = await import('../../src/utils/youtube.js');
    vi.mocked(searchVideos).mockResolvedValue([
      {
        id: 'vid1',
        title: 'Learn TypeScript',
        duration: 600,
        durationFormatted: '10:00',
        channel: 'CodeChannel',
        viewCount: 1500000,
        url: 'https://www.youtube.com/watch?v=vid1',
      },
      {
        id: 'vid2',
        title: 'Advanced TS',
        duration: 1200,
        durationFormatted: '20:00',
        channel: 'DevTips',
        viewCount: 500000,
        url: 'https://www.youtube.com/watch?v=vid2',
      },
    ]);

    const { searchVideosHandler } = await import('../../src/tools/search-videos.js');
    const result = await searchVideosHandler({ query: 'typescript', limit: 5 });

    const text = result.content[0].text;
    expect(text).toContain('Found 2 results for "typescript"');
    expect(text).toContain('Learn TypeScript');
    expect(text).toContain('CodeChannel');
    expect(text).toContain('1.5M views');
    expect(text).toContain('Advanced TS');
  });

  it('should handle empty results', async () => {
    const { searchVideos } = await import('../../src/utils/youtube.js');
    vi.mocked(searchVideos).mockResolvedValue([]);

    const { searchVideosHandler } = await import('../../src/tools/search-videos.js');
    const result = await searchVideosHandler({ query: 'nonexistent', limit: 5 });

    expect(result.content[0].text).toContain('Found 0 results');
  });
});
