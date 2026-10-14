import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { callToolOk, removeHome, startStdioServer, type ServerHandle } from './harness.js';
import { CHANNEL, VIDEO } from './fixtures.js';

/** The discovery tools that need no signed-in session: flat listings, search, health, one image. */
let server: ServerHandle;

beforeAll(async () => {
  server = await startStdioServer();
});

afterAll(async () => {
  await server.close();
  await removeHome(server.home);
});

describe('discovery', () => {
  it('fetch_videos lists a channel tab with thumbnail URLs on an allowlisted host', async () => {
    const { structured } = await callToolOk(server.client, 'fetch_videos', {
      url: `https://www.youtube.com/${CHANNEL.handle}/videos`,
      limit: 5,
    });
    const videos = structured.videos as { id: string; thumbnailUrl?: string }[];
    expect(videos.length).toBeGreaterThan(0);
    for (const video of videos) {
      expect(video.id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(video.thumbnailUrl).toMatch(/^https:\/\/i\.ytimg\.com\//);
    }
  });

  it('get_channel_info returns the avatar and banner on an allowlisted host', async () => {
    const { structured } = await callToolOk(server.client, 'get_channel_info', {
      channel: CHANNEL.handle,
    });
    expect(structured).toMatchObject({ channelId: CHANNEL.id, name: CHANNEL.name });
    expect(structured.avatarUrl).toMatch(/^https:\/\/yt3\.(googleusercontent|ggpht)\.com\//);
    expect(structured.bannerUrl).toMatch(/^https:\/\/yt3\.(googleusercontent|ggpht)\.com\//);
  });

  it('get_channel_info reports the verified badge and keywords the channel page lists', async () => {
    const { structured } = await callToolOk(server.client, 'get_channel_info', {
      channel: CHANNEL.handle,
    });
    expect(structured.isVerified).toBe(true);
    expect(structured.tags).toEqual(expect.arrayContaining([CHANNEL.name]));
  });

  it('harvest_channel treats a tab the channel lacks as an answer, not as an error', async () => {
    const { structured } = await callToolOk(server.client, 'harvest_channel', {
      channel: CHANNEL.handle,
      maxVideos: 3,
    });

    const tabs = structured.tabs as { tab: string; listed: number; error?: string }[];
    expect(tabs.map((tab) => tab.tab)).toEqual([
      'videos',
      'shorts',
      'streams',
      'releases',
      'podcasts',
    ]);
    // Whether or not a given tab exists today, none of them may be reported as a failure.
    for (const tab of tabs) expect(tab.error, `${tab.tab} reported an error`).toBeUndefined();
  });

  it('check_new_uploads compares a real channel’s newest videos with its catalogue', async () => {
    await callToolOk(server.client, 'harvest_channel', { channel: CHANNEL.handle, maxVideos: 3 });

    const { structured } = await callToolOk(server.client, 'check_new_uploads', {
      channel: CHANNEL.handle,
      lookback: 3,
    });

    expect(structured).toMatchObject({ channelId: CHANNEL.id, lookback: 3 });
    expect((structured.checked as { tab: string }[]).length).toBe(5);
  });

  it('list_channel_playlists lists real playlists with links that fetch_videos accepts', async () => {
    const { structured } = await callToolOk(server.client, 'list_channel_playlists', {
      channel: CHANNEL.handle,
      limit: 3,
    });
    expect(structured).toMatchObject({ channelId: CHANNEL.id, channelName: CHANNEL.name });

    const playlists = structured.playlists as { id: string; title: string; url: string }[];
    expect(playlists.length).toBeGreaterThan(0);
    for (const playlist of playlists) {
      expect(playlist.url).toBe(`https://www.youtube.com/playlist?list=${playlist.id}`);
      expect(playlist.title).not.toBe('');
    }

    const listing = await callToolOk(server.client, 'fetch_videos', {
      url: playlists[0]?.url,
      limit: 2,
    });
    expect((listing.structured.videos as unknown[]).length).toBeGreaterThan(0);
  });

  it('search_videos and search_channels return ids and handles', async () => {
    const videos = await callToolOk(server.client, 'search_videos', {
      query: 'Google Search',
      limit: 3,
    });
    expect((videos.structured.videos as unknown[]).length).toBeGreaterThan(0);

    const channels = await callToolOk(server.client, 'search_channels', {
      query: 'Google',
      limit: 3,
    });
    expect((channels.structured.channels as unknown[]).length).toBeGreaterThan(0);
  });

  it('check_health reports both binaries and which session options are set', async () => {
    const { structured } = await callToolOk(server.client, 'check_health');
    expect(structured).toMatchObject({
      ytDlp: { installed: true },
      ffmpeg: { installed: true },
      cookies: expect.stringMatching(/^(file|browser|none)$/) as string,
      proxy: expect.any(Boolean) as boolean,
    });
  });

  it('get_thumbnail returns a real image with its decoded size, over stdio', async () => {
    const { raw, structured } = await callToolOk(server.client, 'get_thumbnail', {
      video: VIDEO.id,
    });
    expect(raw.content[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(structured.width).toBeGreaterThanOrEqual(720);
  });
});
