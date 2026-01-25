import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the youtube utility
vi.mock('../../src/utils/youtube.js', () => ({
  getVideoInfo: vi.fn(),
}));

describe('get-video-info tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return video info as human-readable text', async () => {
    const { getVideoInfo } = await import('../../src/utils/youtube.js');
    vi.mocked(getVideoInfo).mockResolvedValue({
      id: 'test123',
      title: 'Test Video',
      channel: 'Test Channel',
      duration: 300,
      durationFormatted: '5:00',
      uploadDate: '2024-01-15',
      description: 'Test description',
      tags: ['test', 'demo'],
      url: 'https://youtube.com/watch?v=test123',
      thumbnailUrl: 'https://img.youtube.com/test123.jpg',
    });

    const { getVideoInfoHandler } = await import('../../src/tools/get-video-info.js');
    const result = await getVideoInfoHandler({ video: 'test123' });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const text = result.content[0].text;
    expect(text).toContain('Test Video');
    expect(text).toContain('by Test Channel');
    expect(text).toContain('5:00');
    expect(text).toContain('tags: test, demo');
  });

  it('should handle YouTube URLs', async () => {
    const { getVideoInfo } = await import('../../src/utils/youtube.js');
    vi.mocked(getVideoInfo).mockResolvedValue({
      id: 'abc123',
      title: 'URL Test',
      channel: 'Channel',
      duration: 60,
      durationFormatted: '1:00',
      uploadDate: '2024-01-01',
      description: '',
      tags: [],
      url: 'https://youtube.com/watch?v=abc123',
      thumbnailUrl: '',
    });

    const { getVideoInfoHandler } = await import('../../src/tools/get-video-info.js');
    await getVideoInfoHandler({ video: 'https://www.youtube.com/watch?v=abc123' });

    expect(getVideoInfo).toHaveBeenCalledWith('https://www.youtube.com/watch?v=abc123');
  });
});
