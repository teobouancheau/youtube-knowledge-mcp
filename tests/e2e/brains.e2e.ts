import { describe, it, expect, afterAll, beforeAll, inject } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  callToolOk,
  removeHome,
  resourceText,
  startStdioServer,
  type ServerHandle,
} from './harness.js';
import { CHANNEL } from './fixtures.js';

let server: ServerHandle;
let home: string;

beforeAll(async () => {
  server = await startStdioServer();
  home = server.home;
});

afterAll(async () => {
  await server.close();
  await removeHome(home);
});

// Skipped, with the reason printed by the global setup, where YouTube bot-checks the address.
describe.skipIf(!inject('perVideo'))('brains', () => {
  it('builds a small brain, answers from it, and continues after being killed', async () => {
    const victim = await startStdioServer({ home });
    const pending = victim.client
      .callTool({ name: 'build_brain', arguments: { channel: CHANNEL.handle, maxVideos: 6 } })
      .catch(() => undefined);
    await new Promise((done) => setTimeout(done, 15_000));
    victim.kill();
    await pending;

    const manifestPath = join(home, '.youtube-knowledge', 'brains', CHANNEL.id, 'manifest.json');
    const partial = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
      stats: { indexedCount: number };
    };

    const built = await callToolOk(server.client, 'build_brain', {
      channel: CHANNEL.handle,
      maxVideos: 6,
    });
    expect(built.structured.skipped).toBeGreaterThanOrEqual(partial.stats.indexedCount);
    // A brain built from nothing readable would still "exist"; the lane fails
    // instead, naming the code YouTube answered with.
    expect(built.text).not.toContain('could not be read');
    expect(built.structured.considered).toBeGreaterThan(0);

    const info = await callToolOk(server.client, 'get_brain_info', { channel: CHANNEL.id });
    expect(info.structured).toMatchObject({ channelId: CHANNEL.id });

    const brains = await callToolOk(server.client, 'list_brains', {});
    expect((brains.structured.brains as { channelId: string }[]).map((b) => b.channelId)).toContain(
      CHANNEL.id
    );

    const answer = await callToolOk(server.client, 'ask_brain', {
      channel: CHANNEL.id,
      query: 'Google',
      limit: 3,
    });
    expect(Array.isArray(answer.structured.passages)).toBe(true);

    await callToolOk(server.client, 'save_brain_profile', {
      channel: CHANNEL.id,
      content: '# Profile\n',
    });
    const resource = await server.client.readResource({
      uri: `youtube://brain/${CHANNEL.id}/profile`,
    });
    expect(resourceText(resource)).toContain('Profile');

    const deleted = await callToolOk(server.client, 'delete_brain', { channel: CHANNEL.id });
    expect(deleted.structured.deleted).toBe(true);
  });
});
