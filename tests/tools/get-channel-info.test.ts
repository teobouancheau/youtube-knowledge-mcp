import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf } from '../helpers.js';

vi.mock('../../src/utils/youtube.js', () => ({
  getChannelInfo: vi.fn(),
}));

describe('get-channel-info tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return channel info as formatted text', async () => {
    const { getChannelInfo } = await import('../../src/utils/youtube.js');
    vi.mocked(getChannelInfo).mockResolvedValue({
      name: 'Fireship',
      channelId: 'UCsBjURrPoezykLs9EqgamOA',
      handle: '@Fireship',
      subscriberCount: 4190000,
      channelUrl: 'https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA',
      description: 'High-intensity code tutorials and tech news',
    });

    const { getChannelInfoHandler } = await import('../../src/tools/get-channel-info.js');
    const result = await getChannelInfoHandler({ channel: '@Fireship' });

    const text = textOf(result);
    expect(text).toContain('Fireship');
    expect(text).toContain('@Fireship');
    expect(text).toContain('4.2M subscribers');
    expect(text).toContain('High-intensity code tutorials');
  });

  it('shows the verified badge and the keywords the channel lists', async () => {
    const { getChannelInfo } = await import('../../src/utils/youtube.js');
    vi.mocked(getChannelInfo).mockResolvedValue({
      name: 'Google',
      channelId: 'UCK8sQmJBp8GCxrOtXWBpyEA',
      handle: '@Google',
      subscriberCount: 14_600_000,
      channelUrl: 'https://www.youtube.com/channel/UCK8sQmJBp8GCxrOtXWBpyEA',
      description: '',
      isVerified: true,
      tags: ['Google', 'Technology'],
    });

    const { getChannelInfoHandler } = await import('../../src/tools/get-channel-info.js');
    const text = textOf(await getChannelInfoHandler({ channel: '@Google' }));

    expect(text).toContain('Verified');
    expect(text).toContain('Keywords: Google, Technology');
  });

  it('says nothing about verification or keywords it was not given', async () => {
    const { getChannelInfo } = await import('../../src/utils/youtube.js');
    vi.mocked(getChannelInfo).mockResolvedValue({
      name: 'Plain',
      channelId: 'UC111',
      handle: '@Plain',
      subscriberCount: 1,
      channelUrl: 'https://www.youtube.com/channel/UC111',
      description: '',
    });

    const { getChannelInfoHandler } = await import('../../src/tools/get-channel-info.js');
    const text = textOf(await getChannelInfoHandler({ channel: '@Plain' }));

    expect(text).not.toContain('Verified');
    expect(text).not.toContain('Keywords');
  });

  it('should handle channel without description', async () => {
    const { getChannelInfo } = await import('../../src/utils/youtube.js');
    vi.mocked(getChannelInfo).mockResolvedValue({
      name: 'Empty Channel',
      channelId: 'UC000',
      handle: '',
      subscriberCount: 0,
      channelUrl: 'https://www.youtube.com/channel/UC000',
      description: '',
    });

    const { getChannelInfoHandler } = await import('../../src/tools/get-channel-info.js');
    const result = await getChannelInfoHandler({ channel: 'Empty Channel' });

    const text = textOf(result);
    expect(text).toContain('Empty Channel');
    expect(text).toContain('0 subscribers');
    expect(text).not.toContain('undefined');
  });
});
