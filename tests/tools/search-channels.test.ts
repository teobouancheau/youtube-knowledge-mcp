import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf } from '../helpers.js';

vi.mock('../../src/utils/youtube.js', () => ({
  searchChannels: vi.fn(),
}));

describe('search-channels tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return channel results as formatted text', async () => {
    const { searchChannels } = await import('../../src/utils/youtube.js');
    vi.mocked(searchChannels).mockResolvedValue([
      {
        name: 'Fireship',
        channelId: 'UC123',
        handle: '@Fireship',
        subscriberCount: 4190000,
        channelUrl: 'https://www.youtube.com/channel/UC123',
        description: 'High-intensity code tutorials',
      },
    ]);

    const { searchChannelsHandler } = await import('../../src/tools/search-channels.js');
    const result = await searchChannelsHandler({ query: 'fireship', limit: 5 });

    const text = textOf(result);
    expect(text).toContain('Found 1 channel for "fireship"');
    expect(text).toContain('Fireship');
    expect(text).toContain('@Fireship');
    expect(text).toContain('4.2M subscribers');
  });

  it('should handle no results', async () => {
    const { searchChannels } = await import('../../src/utils/youtube.js');
    vi.mocked(searchChannels).mockResolvedValue([]);

    const { searchChannelsHandler } = await import('../../src/tools/search-channels.js');
    const result = await searchChannelsHandler({ query: 'nonexistent', limit: 5 });

    expect(textOf(result)).toContain('No channels found');
  });
});
