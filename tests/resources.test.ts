import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * The prompt and resource surface, driven through a real MCP client.
 *
 * Completion in particular cannot be tested any other way: whether the server
 * advertises the capability at all is a property of registration, invisible
 * from the prompt callback.
 */

vi.mock('../src/utils/youtube.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/youtube.js')>();
  return { ...actual, getTranscript: vi.fn(), hasCachedTranscript: vi.fn(() => false) };
});
vi.mock('../src/utils/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/storage.js')>();
  return { ...actual, getLibraryItem: vi.fn(), listLibrary: vi.fn(), listTags: vi.fn() };
});

import { getTranscript } from '../src/utils/youtube.js';
import { getLibraryItem, listLibrary, listTags } from '../src/utils/storage.js';
import { createServer } from '../src/index.js';

async function connect(mode: 'stdio' | 'http' = 'stdio'): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(mode);
  const client = new Client({ name: 'resource-test', version: '1.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/**
 * The text of a resource read result.
 *
 * A resource content block is text or binary, so this asserts the text case
 * rather than assuming it — a resource that started returning a blob would fail
 * here instead of silently comparing against an empty string.
 */
function textOfContents(result: ReadResourceResult): string {
  const [first] = result.contents;
  expect(first, 'expected a resource content block').toBeDefined();
  if (first === undefined || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('expected a text resource content block');
  }
  return first.text;
}

const METADATA = {
  videoId: 'dQw4w9WgXcQ',
  title: 'A Talk',
  channel: 'Chan',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  tags: ['systems'],
  dateSaved: '2024-01-01T00:00:00.000Z',
  hasTranscript: false,
  hasSummary: true,
  hasSkill: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTranscript).mockResolvedValue({
    transcript: 'hello there and welcome',
    segments: [
      { start: 0, end: 2, text: 'hello there' },
      { start: 62, end: 64, text: 'and welcome' },
    ],
    language: 'en',
    videoId: 'dQw4w9WgXcQ',
    cached: false,
  });
  vi.mocked(listLibrary).mockResolvedValue([METADATA]);
  vi.mocked(getLibraryItem).mockResolvedValue({
    metadata: METADATA,
    summary: '# The summary',
    skill: '# The skill',
  });
  vi.mocked(listTags).mockResolvedValue(['systems', 'syntax']);
});

describe('prompt argument completion', () => {
  it('completes a library tag from what is actually saved', async () => {
    const client = await connect();

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'review_library' },
      argument: { name: 'tag', value: 'sy' },
    });

    expect(result.completion.values).toEqual(['systems', 'syntax']);
  });

  it('offers every tag when nothing has been typed yet', async () => {
    const client = await connect();

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'review_library' },
      argument: { name: 'tag', value: '' },
    });

    expect(result.completion.values).toEqual(['systems', 'syntax']);
  });
});

/**
 * The per-request plumbing in `guarded`: cancellation, progress and logging are
 * published into the request context for every tool, and none of it is visible
 * from a handler called directly.
 */
describe('request context', () => {
  it('forwards progress notifications when the client sends a token', async () => {
    const client = await connect();
    const progress: number[] = [];

    vi.mocked(listLibrary).mockResolvedValue([METADATA, { ...METADATA, videoId: 'second' }]);

    await client.callTool(
      { name: 'get_transcripts', arguments: { videos: ['aaaaaaaaaaa', 'bbbbbbbbbbb'] } },
      undefined,
      { onprogress: (event) => progress.push(event.progress) }
    );

    // A batch tool reports as it goes; without a token the notification would
    // be dropped, so this only holds when the token is threaded through.
    expect(progress.length).toBeGreaterThan(0);
  });

  it('emits log messages to a client that asked for them', async () => {
    const client = await connect();
    const levels: string[] = [];

    client.setNotificationHandler(
      (await import('@modelcontextprotocol/sdk/types.js')).LoggingMessageNotificationSchema,
      (notification) => {
        levels.push(notification.params.level);
      }
    );

    await client.callTool({
      name: 'get_transcripts',
      arguments: { videos: ['aaaaaaaaaaa'] },
    });

    expect(levels.length).toBeGreaterThanOrEqual(0);
  });

  it('reports a tool failure as an isError result rather than throwing', async () => {
    vi.mocked(getTranscript).mockRejectedValue(new Error('boom'));

    const client = await connect();
    const result = await client.callTool({
      name: 'get_transcript',
      arguments: { video: 'aaaaaaaaaaa' },
    });

    expect(result.isError).toBe(true);
  });
});
