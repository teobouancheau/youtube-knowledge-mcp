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
