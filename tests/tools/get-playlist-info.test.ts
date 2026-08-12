import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf } from '../helpers.js';

vi.mock('../../src/utils/youtube.js', () => ({
  getPlaylistInfo: vi.fn(),
}));

describe('get-playlist-info tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return playlist info as formatted text', async () => {
    const { getPlaylistInfo } = await import('../../src/utils/youtube.js');
    vi.mocked(getPlaylistInfo).mockResolvedValue({
      id: 'PLtest123',
      title: 'C++ Tutorial Series',
      channel: 'The Cherno',
      handle: '@TheCherno',
      channelUrl: 'https://www.youtube.com/channel/UC123',
      videoCount: 115,
      lastModified: '2026-02-26',
      url: 'https://www.youtube.com/playlist?list=PLtest123',
      description: 'Complete C++ course',
    });

    const { getPlaylistInfoHandler } = await import('../../src/tools/get-playlist-info.js');
    const result = await getPlaylistInfoHandler({
      url: 'https://www.youtube.com/playlist?list=PLtest123',
    });

    const text = textOf(result);
    expect(text).toContain('C++ Tutorial Series');
    expect(text).toContain('by The Cherno');
    expect(text).toContain('115 videos');
    expect(text).toContain('Last updated: 2026-02-26');
    expect(text).toContain('Complete C++ course');
  });

  it('should handle playlist without description', async () => {
    const { getPlaylistInfo } = await import('../../src/utils/youtube.js');
    vi.mocked(getPlaylistInfo).mockResolvedValue({
      id: 'PLempty',
      title: 'Empty Playlist',
      channel: '',
      handle: '',
      channelUrl: '',
      videoCount: 0,
      lastModified: '',
      url: 'https://www.youtube.com/playlist?list=PLempty',
      description: '',
    });

    const { getPlaylistInfoHandler } = await import('../../src/tools/get-playlist-info.js');
    const result = await getPlaylistInfoHandler({
      url: 'https://www.youtube.com/playlist?list=PLempty',
    });

    const text = textOf(result);
    expect(text).toContain('Empty Playlist');
    expect(text).toContain('0 videos');
  });
});
