import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  removeHome,
  startStdioServer,
  startStdioServerViaSymlink,
  startHttpServer,
} from './harness.js';

/** The built server's surface, over both transports, against what the unit lane snapshots. */
describe('protocol', () => {
  it('reports the package version on initialize, directly and through a symlinked bin', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf-8')) as { version: string };
    for (const start of [startStdioServer, startStdioServerViaSymlink]) {
      const server = await start();
      expect(server.client.getServerVersion()).toMatchObject({ version: pkg.version });
      await server.close();
      await removeHome(server.home);
    }
  });

  it('lists 37 tools on stdio and 15 over HTTP, every one with an output schema and all four hints', async () => {
    const stdio = await startStdioServer();
    const http = await startHttpServer();
    const local = (await stdio.client.listTools()).tools;
    const remote = (await http.client.listTools()).tools;

    expect(local).toHaveLength(37);
    expect(remote).toHaveLength(15);
    for (const tool of local) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: expect.any(Boolean) as boolean,
        destructiveHint: expect.any(Boolean) as boolean,
        idempotentHint: expect.any(Boolean) as boolean,
        openWorldHint: expect.any(Boolean) as boolean,
      });
    }

    await stdio.close();
    await http.close();
    await removeHome(stdio.home);
    await removeHome(http.home);
  });

  it('lists prompts and resources per transport, and completes a library tag', async () => {
    const stdio = await startStdioServer();
    const http = await startHttpServer();

    const localPrompts = (await stdio.client.listPrompts()).prompts.map((p) => p.name);
    const remotePrompts = (await http.client.listPrompts()).prompts.map((p) => p.name);
    expect(localPrompts).toEqual(
      expect.arrayContaining(['review_library', 'create_brain', 'study_thumbnails'])
    );
    expect(remotePrompts).not.toContain('review_library');

    const localTemplates = (await stdio.client.listResourceTemplates()).resourceTemplates.map(
      (t) => t.uriTemplate
    );
    const remoteTemplates = (await http.client.listResourceTemplates()).resourceTemplates.map(
      (t) => t.uriTemplate
    );
    expect(localTemplates).toContain('youtube://thumbnails/{channelId}/manifest');
    expect(remoteTemplates).toEqual(['youtube://transcript/{videoId}']);

    const completion = await stdio.client.complete({
      ref: { type: 'ref/prompt', name: 'review_library' },
      argument: { name: 'tag', value: '' },
    });
    expect(completion.completion.values).toEqual([]);

    await stdio.close();
    await http.close();
    await removeHome(stdio.home);
    await removeHome(http.home);
  });
});
