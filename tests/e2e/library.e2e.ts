import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  callTool,
  callToolOk,
  removeHome,
  resourceText,
  startStdioServer,
  type ServerHandle,
} from './harness.js';

let server: ServerHandle;

beforeAll(async () => {
  server = await startStdioServer();
});

afterAll(async () => {
  await server.close();
  await removeHome(server.home);
});

describe('library', () => {
  const videoId = 'dQw4w9WgXcQ';

  it('saves, lists, reads, searches, retags and deletes a note, and exposes it as a resource', async () => {
    await callToolOk(server.client, 'save_to_library', {
      videoId,
      title: 'A note',
      content: 'Rate limiting is about protecting the backend.',
      contentType: 'summary',
      tags: ['systems'],
    });

    const listed = await callToolOk(server.client, 'list_library', {});
    expect((listed.structured.items as { videoId: string }[]).map((i) => i.videoId)).toContain(
      videoId
    );

    const item = await callToolOk(server.client, 'get_library_item', { videoId });
    expect(item.structured.summary).toContain('Rate limiting');

    const hits = await callToolOk(server.client, 'search_library', { query: 'backend' });
    expect((hits.structured.hits as unknown[]).length).toBe(1);

    const retagged = await callToolOk(server.client, 'update_library_tags', {
      videoId,
      add: ['api'],
    });
    expect(retagged.structured.tags).toEqual(expect.arrayContaining(['systems', 'api']));

    const resource = await server.client.readResource({
      uri: `youtube://library/${videoId}/summary`,
    });
    expect(resourceText(resource)).toContain('Rate limiting');

    const rebuilt = await callToolOk(server.client, 'rebuild_library_index', {});
    expect(rebuilt.structured.documents).toBe(1);

    const deleted = await callToolOk(server.client, 'delete_library_item', { videoId });
    expect(deleted.structured.deleted).toContain('summary');
  });

  it('refuses a traversal id before writing anything', async () => {
    const result = await callTool(server.client, 'save_to_library', {
      videoId: '../../x',
      title: 't',
      content: 'c',
      contentType: 'summary',
    });
    expect(result.isError).toBe(true);
  });
});
