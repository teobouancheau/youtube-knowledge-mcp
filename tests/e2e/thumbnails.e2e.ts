import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  callToolOk,
  removeHome,
  resourceText,
  startStdioServer,
  type ServerHandle,
} from './harness.js';
import { CHANNEL } from './fixtures.js';
import { probeImage } from '../../src/utils/image-dimensions.js';

/**
 * The thumbnail tools against the real channel and YouTube's real image hosts,
 * including the two resumability properties: a killed run continues, and a
 * lost file is fetched again on its own.
 */
let server: ServerHandle;
let home: string;
const args = { channel: CHANNEL.handle, maxVideos: 10, tabs: ['videos', 'shorts'] };

beforeAll(async () => {
  server = await startStdioServer();
  home = server.home;
});

afterAll(async () => {
  await server.close();
  await removeHome(home);
});

describe('fetch_channel_thumbnails', () => {
  it('saves the videos, shorts, avatar and banner, and every recorded size is the decoded size', async () => {
    const { structured } = await callToolOk(server.client, 'fetch_channel_thumbnails', args);
    expect(structured).toMatchObject({ channelId: CHANNEL.id, failed: 0, stoppedEarly: false });
    expect(structured.avatar).toMatchObject({ state: 'saved' });
    expect(structured.banner).toMatchObject({ state: 'saved' });

    const listed = await callToolOk(server.client, 'list_channel_thumbnails', {
      channel: CHANNEL.id,
      limit: 200,
    });
    const entries = listed.structured.thumbnails as {
      path: string;
      width: number;
      height: number;
      bytes: number;
      tab: string;
      isShort: boolean;
    }[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const bytes = await readFile(entry.path);
      const probe = probeImage(bytes);
      expect(probe, entry.path).toMatchObject({ width: entry.width, height: entry.height });
      expect(bytes.byteLength).toBe(entry.bytes);
    }
    const shorts = entries.filter((entry) => entry.tab === 'shorts');
    expect(shorts.length).toBeGreaterThan(0);
    expect(shorts.every((entry) => entry.isShort && entry.height > entry.width)).toBe(true);
  });

  it('fetches again only what went missing', async () => {
    const listed = await callToolOk(server.client, 'list_channel_thumbnails', {
      channel: CHANNEL.id,
      limit: 1,
    });
    const [entry] = listed.structured.thumbnails as { path: string }[];
    expect(entry).toBeDefined();
    await rm(entry?.path ?? '');

    const { structured } = await callToolOk(server.client, 'fetch_channel_thumbnails', args);
    expect(structured).toMatchObject({ fetched: 1, failed: 0 });
    expect((await stat(entry?.path ?? '')).size).toBeGreaterThan(0);
  });

  it('continues after the server is killed mid-run', async () => {
    const victim = await startStdioServer({ home });
    const pending = victim.client
      .callTool({
        name: 'fetch_channel_thumbnails',
        arguments: { channel: CHANNEL.handle, maxVideos: 60, tabs: ['videos'] },
      })
      .catch(() => undefined);
    await new Promise((done) => setTimeout(done, 4000));
    victim.kill();
    await pending;

    const manifest = JSON.parse(
      await readFile(
        join(home, '.youtube-knowledge', 'thumbnails', CHANNEL.id, 'manifest.json'),
        'utf-8'
      )
    ) as { stats: { savedCount: number; videoCount: number } };
    const before = manifest.stats.savedCount;

    const { structured } = await callToolOk(server.client, 'fetch_channel_thumbnails', {
      channel: CHANNEL.handle,
      maxVideos: 60,
      tabs: ['videos'],
    });
    expect(structured.skipped).toBeGreaterThanOrEqual(before);
    expect(structured.failed).toBe(0);
  });

  it('serves a saved thumbnail from disk and exposes the manifest as a resource', async () => {
    const listed = await callToolOk(server.client, 'list_channel_thumbnails', {
      channel: CHANNEL.id,
      limit: 1,
    });
    const [entry] = listed.structured.thumbnails as { videoId: string; width: number }[];

    const image = await callToolOk(server.client, 'get_thumbnail', { video: entry?.videoId });
    expect(image.structured).toMatchObject({ fromDisk: true, width: entry?.width });

    const resource = await server.client.readResource({
      uri: `youtube://thumbnails/${CHANNEL.id}/manifest`,
    });
    expect(JSON.parse(resourceText(resource))).toMatchObject({
      channel: { channelId: CHANNEL.id },
    });
  });

  it('deletes the set', async () => {
    const { structured } = await callToolOk(server.client, 'delete_channel_thumbnails', {
      channel: CHANNEL.id,
    });
    expect(structured).toMatchObject({ deleted: true });
  });
});
