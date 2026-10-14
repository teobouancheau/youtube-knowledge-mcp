import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/ytdlp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/ytdlp.js')>();
  return { ...actual, runYtDlp: vi.fn() };
});
vi.mock('../../src/utils/youtube-channel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/youtube-channel.js')>();
  return { ...actual, getChannelInfo: vi.fn() };
});

import { runYtDlp } from '../../src/utils/ytdlp.js';
import { YouTubeError } from '../../src/utils/errors.js';
import { getChannelInfo } from '../../src/utils/youtube-channel.js';
import { listChannelPlaylists } from '../../src/utils/channel-playlists.js';

const CHANNEL = {
  name: 'Google',
  channelId: 'UCK8sQmJBp8GCxrOtXWBpyEA',
  handle: '@Google',
  subscriberCount: 1,
  channelUrl: 'https://www.youtube.com/channel/UCK8sQmJBp8GCxrOtXWBpyEA',
  description: '',
};

const row = (id: string, title: string): string =>
  JSON.stringify({ id, title, url: `https://www.youtube.com/playlist?list=${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChannelInfo).mockResolvedValue(CHANNEL);
  vi.mocked(runYtDlp).mockResolvedValue([row('PL1', 'First'), row('PL2', 'Second')].join('\n'));
});

describe('a channel without a playlists tab', () => {
  it('has no playlists, which is an answer and not an error', async () => {
    vi.mocked(runYtDlp).mockRejectedValue(
      new YouTubeError('NOT_FOUND', 'This channel does not have that tab.')
    );

    expect(await listChannelPlaylists('@Google', 5)).toMatchObject({
      playlists: [],
      mayHaveMore: false,
    });
  });

  it('still reports any other failure', async () => {
    vi.mocked(runYtDlp).mockRejectedValue(new YouTubeError('RATE_LIMITED', 'Slow down.'));

    await expect(listChannelPlaylists('@Google', 5)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});

describe('listChannelPlaylists', () => {
  it('lists the playlists of the channel the caller named, however they named it', async () => {
    const result = await listChannelPlaylists('@Google', 50);

    expect(getChannelInfo).toHaveBeenCalledWith('@Google');
    expect(result).toMatchObject({
      channelId: CHANNEL.channelId,
      channelName: 'Google',
      playlists: [
        { id: 'PL1', title: 'First', url: 'https://www.youtube.com/playlist?list=PL1' },
        { id: 'PL2', title: 'Second' },
      ],
    });
  });

  it('asks yt-dlp for the channel playlists tab, flat, up to the limit', async () => {
    await listChannelPlaylists('@Google', 7);

    const [args = [], options] = vi.mocked(runYtDlp).mock.calls[0] ?? [];
    expect(args).toContain('--flat-playlist');
    expect(args[args.indexOf('--playlist-items') + 1]).toBe('1:7');
    expect(options?.target).toBe(`${CHANNEL.channelUrl}/playlists`);
  });

  it('says there may be more when it filled the limit', async () => {
    expect((await listChannelPlaylists('@Google', 2)).mayHaveMore).toBe(true);
    expect((await listChannelPlaylists('@Google', 3)).mayHaveMore).toBe(false);
  });

  it('names an untitled playlist and builds the link YouTube would have given', async () => {
    vi.mocked(runYtDlp).mockResolvedValue(JSON.stringify({ id: 'PL9' }));

    const { playlists } = await listChannelPlaylists('@Google', 5);

    expect(playlists).toEqual([
      { id: 'PL9', title: 'Untitled', url: 'https://www.youtube.com/playlist?list=PL9' },
    ]);
  });

  it('returns an empty list for a channel with no playlists', async () => {
    vi.mocked(runYtDlp).mockResolvedValue('');

    expect(await listChannelPlaylists('@Google', 5)).toMatchObject({
      playlists: [],
      mayHaveMore: false,
    });
  });

  it('skips a malformed row without losing the others', async () => {
    vi.mocked(runYtDlp).mockResolvedValue(['not json', row('PL1', 'First')].join('\n'));

    expect((await listChannelPlaylists('@Google', 5)).playlists).toHaveLength(1);
  });
});
