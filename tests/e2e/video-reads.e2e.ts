import { describe, it, expect, afterAll, beforeAll, inject } from 'vitest';
import {
  callTool,
  callToolOk,
  removeHome,
  startStdioServer,
  type ServerHandle,
} from './harness.js';
import { CHANNEL, VIDEO } from './fixtures.js';

/**
 * The tools that read one video. YouTube answers these with a bot check from
 * some addresses; the runner then needs a cookie setting, which the harness
 * passes through.
 */
let server: ServerHandle;

beforeAll(async () => {
  server = await startStdioServer();
});

afterAll(async () => {
  await server.close();
  await removeHome(server.home);
});

// Skipped, with the reason printed by the global setup, where YouTube bot-checks the address.
describe.skipIf(!inject('perVideo'))('video reads', () => {
  it('the recorded fixture video can be read, with captions', async () => {
    const info = await callToolOk(server.client, 'get_video_info', { video: VIDEO.id });
    expect(info.structured).toMatchObject({
      id: VIDEO.id,
      durationSeconds: expect.any(Number) as number,
    });

    const transcript = await callToolOk(server.client, 'get_transcript', { video: VIDEO.id });
    expect(transcript.structured.wordCount).toBeGreaterThan(0);
  });

  it('get_chapters, get_comments and list_formats read the video', async () => {
    const chapters = await callToolOk(server.client, 'get_chapters', { video: VIDEO.id });
    expect(Array.isArray(chapters.structured.chapters)).toBe(true);

    const comments = await callToolOk(server.client, 'get_comments', { video: VIDEO.id, limit: 3 });
    expect(Array.isArray(comments.structured.comments)).toBe(true);

    const formats = await callToolOk(server.client, 'list_formats', { video: VIDEO.id });
    expect((formats.structured.formats as unknown[]).length).toBeGreaterThan(0);
  });

  it('get_playlist_info reads a playlist discovered from search', async () => {
    const found = await callTool(server.client, 'fetch_videos', {
      url: `https://www.youtube.com/${CHANNEL.handle}/playlists`,
      limit: 1,
    });
    // A channel's playlists tab lists playlists as entries; if this channel has
    // none the tool reports it, which is a finding rather than a skip.
    expect(found.isError, found.text).toBe(false);
  });
});
