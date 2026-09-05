import { describe, it, expect, afterAll, beforeAll, inject } from 'vitest';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  callTool,
  callToolOk,
  removeHome,
  resourceText,
  startStdioServer,
  type ServerHandle,
} from './harness.js';
import { VIDEO } from './fixtures.js';

let server: ServerHandle;

beforeAll(async () => {
  server = await startStdioServer();
});

afterAll(async () => {
  await server.close();
  await removeHome(server.home);
});

// Skipped, with the reason printed by the global setup, where YouTube bot-checks the address.
describe.skipIf(!inject('perVideo'))('transcripts', () => {
  it('get_transcript fetches, caches owner-only, and serves the cache next time', async () => {
    const first = await callToolOk(server.client, 'get_transcript', { video: VIDEO.id });
    expect(first.structured.cached).toBe(false);

    const cacheDir = join(server.home, '.youtube-knowledge', 'transcripts');
    const files = (await readdir(cacheDir)).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const mode = (await stat(join(cacheDir, files[0] ?? ''))).mode & 0o777;
    expect(process.platform === 'win32' ? 0o600 : mode).toBe(0o600);

    const second = await callToolOk(server.client, 'get_transcript', { video: VIDEO.id });
    expect(second.structured.cached).toBe(true);
  });

  it('search_transcript returns links that open the moment, and refuses a runaway pattern', async () => {
    const transcript = await callToolOk(server.client, 'get_transcript', { video: VIDEO.id });
    const word =
      (transcript.structured.transcript as string).split(/\s+/).find((w) => w.length > 4) ?? 'the';

    const found = await callToolOk(server.client, 'search_transcript', {
      video: VIDEO.id,
      query: word,
    });
    const matches = found.structured.matches as { url: string }[];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.url).toMatch(new RegExp(`v=${VIDEO.id}&t=\\d+s$`));

    const refused = await callTool(server.client, 'search_transcript', {
      video: VIDEO.id,
      query: '(a+)+$',
      regex: true,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('[INVALID_INPUT]');
  });

  it('get_transcripts and digest_playlist survey several videos in one call', async () => {
    const batch = await callToolOk(server.client, 'get_transcripts', { videos: [VIDEO.id] });
    expect((batch.structured.results as unknown[]).length).toBe(1);

    const digest = await callToolOk(server.client, 'digest_playlist', {
      url: 'https://www.youtube.com/@Google/videos',
      limit: 2,
    });
    expect((digest.structured.videos as unknown[]).length).toBeGreaterThan(0);
  });

  it('the transcript resource reads the same text', async () => {
    const resource = await server.client.readResource({ uri: `youtube://transcript/${VIDEO.id}` });
    expect(resourceText(resource)).toMatch(/\[\d+:\d\d\]/);
  });
});
