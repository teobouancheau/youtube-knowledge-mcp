import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { callToolOk, removeHome, startStdioServer, type ServerHandle } from './harness.js';
import { CHANNEL, SHORT, STREAM, VIDEO } from './fixtures.js';

/**
 * Re-verifies what fixtures.ts claims, so a target that changed on YouTube
 * fails here by name. Runs first: the file is named to sort before the rest.
 * The per-video properties are checked by video-reads.e2e.ts, which needs a
 * signed-in session on some networks.
 */
let server: ServerHandle;

beforeAll(async () => {
  server = await startStdioServer();
});

afterAll(async () => {
  await server.close();
  await removeHome(server.home);
});

describe('fixtures', () => {
  it('the channel still resolves to the recorded id', async () => {
    const { structured } = await callToolOk(server.client, 'get_channel_info', {
      channel: CHANNEL.handle,
    });
    expect(structured).toMatchObject({ channelId: CHANNEL.id });
  });

  it('the recorded video, short and stream are still listed under their tabs', async () => {
    for (const [tab, id] of [
      ['videos', VIDEO.id],
      ['shorts', SHORT.id],
      ['streams', STREAM.id],
    ] as const) {
      const { structured } = await callToolOk(server.client, 'fetch_videos', {
        url: `https://www.youtube.com/${CHANNEL.handle}/${tab}`,
        limit: 100,
      });
      const listed = (structured.videos as { id: string }[]).map((video) => video.id);
      expect(listed, `${id} not in the first 100 of ${tab}`).toContain(id);
    }
  });
});
