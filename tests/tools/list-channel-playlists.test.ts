import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/channel-playlists.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/channel-playlists.js')>()),
  listChannelPlaylists: vi.fn(),
}));

import { listChannelPlaylists } from '../../src/utils/channel-playlists.js';
import { listChannelPlaylistsHandler } from '../../src/tools/list-channel-playlists.js';

const PLAYLISTS = {
  channelId: 'UCch',
  channelName: 'Google',
  playlists: [
    { id: 'PL1', title: 'First', url: 'https://www.youtube.com/playlist?list=PL1' },
    { id: 'PL2', title: 'Second', url: 'https://www.youtube.com/playlist?list=PL2' },
  ],
  mayHaveMore: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listChannelPlaylists).mockResolvedValue(PLAYLISTS);
});

describe('listChannelPlaylistsHandler', () => {
  it('forwards the channel and the limit', async () => {
    await listChannelPlaylistsHandler({ channel: '@Google', limit: 30 });

    expect(listChannelPlaylists).toHaveBeenCalledWith('@Google', 30);
  });

  it('lists each playlist with its link, and reports the count', async () => {
    const result = await listChannelPlaylistsHandler({ channel: '@Google', limit: 30 });

    expect(textOf(result)).toContain('Google: 2 playlists');
    expect(textOf(result)).toContain('1. First');
    expect(textOf(result)).toContain('https://www.youtube.com/playlist?list=PL2');
    expect(structuredOf(result)).toMatchObject({
      channelId: 'UCch',
      count: 2,
      mayHaveMore: false,
      playlists: PLAYLISTS.playlists,
    });
  });

  it('says how to see more when the limit was reached', async () => {
    vi.mocked(listChannelPlaylists).mockResolvedValue({ ...PLAYLISTS, mayHaveMore: true });

    const result = await listChannelPlaylistsHandler({ channel: '@Google', limit: 2 });

    expect(textOf(result)).toContain('Raise limit');
    expect(structuredOf(result)).toMatchObject({ mayHaveMore: true });
  });

  it('says plainly that a channel has no playlists', async () => {
    vi.mocked(listChannelPlaylists).mockResolvedValue({
      ...PLAYLISTS,
      playlists: [],
    });

    const result = await listChannelPlaylistsHandler({ channel: '@Google', limit: 30 });

    expect(textOf(result)).toContain('has no public playlists');
    expect(structuredOf(result)).toMatchObject({ count: 0, playlists: [] });
  });
});
