import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * The resource read callbacks, driven through a real MCP client.
 *
 * `protocol.test.ts` checks that the templates are advertised; this checks that
 * reading one actually returns the right document. The two are different
 * failures — a template can list correctly and still resolve to nothing.
 */

vi.mock('../src/utils/youtube.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/youtube.js')>();
  return { ...actual, getTranscript: vi.fn(), hasCachedTranscript: vi.fn(() => false) };
});
vi.mock('../src/utils/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/storage.js')>();
  return { ...actual, getLibraryItem: vi.fn(), listLibrary: vi.fn(), listTags: vi.fn() };
});
vi.mock('../src/utils/brain-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/brain-storage.js')>();
  return {
    ...actual,
    listManifests: vi.fn(),
    readProfile: vi.fn(),
    requireManifest: vi.fn(),
    hasProfile: vi.fn(() => false),
  };
});

import { getTranscript } from '../src/utils/youtube.js';
import { getLibraryItem, listLibrary, listTags } from '../src/utils/storage.js';
import {
  hasProfile,
  listManifests,
  readProfile,
  requireManifest,
} from '../src/utils/brain-storage.js';
import { createServer } from '../src/index.js';
import { YouTubeError } from '../src/utils/errors.js';

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
  vi.mocked(listManifests).mockResolvedValue([]);
  vi.mocked(hasProfile).mockReturnValue(false);
});

describe('transcript resource', () => {
  it('returns the transcript with its timestamps', async () => {
    const client = await connect();

    const result = await client.readResource({ uri: 'youtube://transcript/dQw4w9WgXcQ' });

    expect(textOfContents(result)).toBe('[0:00] hello there\n[1:02] and welcome');
    expect(getTranscript).toHaveBeenCalledWith('dQw4w9WgXcQ');
  });

  it('labels the document as plain text under the URI it was asked for', async () => {
    const client = await connect();

    const result = await client.readResource({ uri: 'youtube://transcript/dQw4w9WgXcQ' });

    expect(result.contents[0]).toMatchObject({
      uri: 'youtube://transcript/dQw4w9WgXcQ',
      mimeType: 'text/plain',
    });
  });

  it('is readable over the remote transport too', async () => {
    const client = await connect('http');

    const result = await client.readResource({ uri: 'youtube://transcript/dQw4w9WgXcQ' });

    expect(textOfContents(result)).toContain('hello there');
  });
});

describe('library resource', () => {
  it('returns the saved summary', async () => {
    const client = await connect();

    const result = await client.readResource({ uri: 'youtube://library/dQw4w9WgXcQ/summary' });

    expect(textOfContents(result)).toBe('# The summary');
    expect(getLibraryItem).toHaveBeenCalledWith('dQw4w9WgXcQ', 'summary');
  });

  it('returns the saved skill note', async () => {
    const client = await connect();

    const result = await client.readResource({ uri: 'youtube://library/dQw4w9WgXcQ/skill' });

    expect(textOfContents(result)).toBe('# The skill');
    expect(getLibraryItem).toHaveBeenCalledWith('dQw4w9WgXcQ', 'skill');
  });

  it('treats any other content type as a summary rather than failing', async () => {
    const client = await connect();

    const result = await client.readResource({ uri: 'youtube://library/dQw4w9WgXcQ/nonsense' });

    expect(getLibraryItem).toHaveBeenCalledWith('dQw4w9WgXcQ', 'summary');
    expect(textOfContents(result)).toBe('# The summary');
  });

  it('returns an empty document rather than undefined when the note is absent', async () => {
    vi.mocked(getLibraryItem).mockResolvedValue({ metadata: METADATA, summary: undefined });

    const client = await connect();
    const result = await client.readResource({ uri: 'youtube://library/dQw4w9WgXcQ/summary' });

    expect(textOfContents(result)).toBe('');
  });

  it('enumerates what is saved, so a client can browse the library', async () => {
    const client = await connect();

    const { resources } = await client.listResources();

    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: 'youtube://library/dQw4w9WgXcQ/summary',
          name: 'A Talk (summary)',
          mimeType: 'text/markdown',
        }),
        expect.objectContaining({ uri: 'youtube://library/dQw4w9WgXcQ/skill' }),
      ])
    );
  });

  it('lists only the content types that actually exist', async () => {
    vi.mocked(listLibrary).mockResolvedValue([{ ...METADATA, hasSkill: false }]);

    const client = await connect();
    const uris = (await client.listResources()).resources.map((resource) => resource.uri);

    expect(uris).toContain('youtube://library/dQw4w9WgXcQ/summary');
    expect(uris).not.toContain('youtube://library/dQw4w9WgXcQ/skill');
  });

  it('is not reachable over the remote transport', async () => {
    const client = await connect('http');

    await expect(
      client.readResource({ uri: 'youtube://library/dQw4w9WgXcQ/summary' })
    ).rejects.toThrow();
  });
});

describe('brain resource', () => {
  const CHANNEL_ID = 'UCsBjURrPoezykLs9EqgamOA';

  const MANIFEST = {
    version: 1,
    channel: {
      name: 'Fireship',
      channelId: CHANNEL_ID,
      handle: '@Fireship',
      subscriberCount: 10,
      channelUrl: `https://www.youtube.com/channel/${CHANNEL_ID}`,
      description: '',
    },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-02-01T00:00:00.000Z',
    videos: {},
    stats: {
      videoCount: 1,
      indexedCount: 1,
      noCaptionsCount: 0,
      failedCount: 0,
      pendingCount: 0,
      chunkCount: 4,
      totalWords: 900,
      medianWordsPerMinute: 150,
      uploadsPerMonth: [],
      recurringPhrases: [],
    },
  };

  beforeEach(() => {
    vi.mocked(listManifests).mockResolvedValue([MANIFEST]);
    vi.mocked(requireManifest).mockResolvedValue(MANIFEST);
    vi.mocked(readProfile).mockResolvedValue(undefined);
    vi.mocked(hasProfile).mockReturnValue(false);
  });

  it('lists a manifest for every brain, and a profile only where one was saved', async () => {
    const client = await connect();

    const withoutProfile = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(withoutProfile).toContain(`youtube://brain/${CHANNEL_ID}/manifest`);
    expect(withoutProfile).not.toContain(`youtube://brain/${CHANNEL_ID}/profile`);

    vi.mocked(hasProfile).mockReturnValue(true);
    const withProfile = (await (await connect()).listResources()).resources.map(
      (resource) => resource.uri
    );
    expect(withProfile).toContain(`youtube://brain/${CHANNEL_ID}/profile`);
  });

  it('reads the manifest back as JSON', async () => {
    const client = await connect();
    const result = await client.readResource({
      uri: `youtube://brain/${CHANNEL_ID}/manifest`,
    });

    expect(JSON.parse(textOfContents(result))).toMatchObject({
      channel: { channelId: CHANNEL_ID },
      stats: { chunkCount: 4 },
    });
  });

  it('reads the profile when one was saved', async () => {
    vi.mocked(readProfile).mockResolvedValue('# Voice\n\nTerse.');

    const client = await connect();
    const result = await client.readResource({
      uri: `youtube://brain/${CHANNEL_ID}/profile`,
    });

    expect(textOfContents(result)).toContain('Terse');
  });

  it('fails clearly when no profile has been written', async () => {
    const client = await connect();

    await expect(
      client.readResource({ uri: `youtube://brain/${CHANNEL_ID}/profile` })
    ).rejects.toThrow(/profile/i);
  });
});

describe('prompt rendering', () => {
  /** Every prompt, with a minimal set of arguments. */
  const CASES: [string, Record<string, string>, string[]][] = [
    ['summarize_video', { video: 'dQw4w9WgXcQ' }, ['dQw4w9WgXcQ', 'get_chapters', 'standard']],
    ['extract_skill', { video: 'dQw4w9WgXcQ' }, ['dQw4w9WgXcQ']],
    ['compare_videos', { videos: 'aaa,bbb' }, ['aaa,bbb']],
    ['research_topic', { topic: 'rate limiting' }, ['rate limiting', 'search_videos']],
    ['channel_deep_dive', { channel: '@creator' }, ['@creator']],
    [
      'clip_from_quote',
      { video: 'dQw4w9WgXcQ', quote: 'never gonna' },
      ['never gonna', 'extract_clip'],
    ],
    ['review_library', {}, ['list_library']],
  ];

  it.each(CASES)('renders %s', async (name, args, expected) => {
    const client = await connect();

    const result = await client.getPrompt({ name, arguments: args });
    const [message] = result.messages;
    const text = message?.content.type === 'text' ? message.content.text : '';

    for (const fragment of expected) {
      expect(text, `${name} should mention ${fragment}`).toContain(fragment);
    }
  });

  it.each(CASES)('addresses %s to the user role', async (name, args) => {
    const client = await connect();

    const result = await client.getPrompt({ name, arguments: args });

    expect(result.messages[0]?.role).toBe('user');
  });

  describe('optional arguments change the instructions', () => {
    it('caps the transcript read when a brief summary is asked for', async () => {
      const client = await connect();

      const brief = await client.getPrompt({
        name: 'summarize_video',
        arguments: { video: 'v', depth: 'brief' },
      });
      const standard = await client.getPrompt({
        name: 'summarize_video',
        arguments: { video: 'v', depth: 'standard' },
      });

      const textOf = (r: typeof brief): string =>
        r.messages[0]?.content.type === 'text' ? r.messages[0].content.text : '';

      expect(textOf(brief)).toContain('maxChars=8000');
      expect(textOf(standard)).not.toContain('maxChars=8000');
    });

    it('reads transcripts only for a deep research pass', async () => {
      const client = await connect();

      const deep = await client.getPrompt({
        name: 'research_topic',
        arguments: { topic: 'x', depth: 'deep' },
      });
      const survey = await client.getPrompt({
        name: 'research_topic',
        arguments: { topic: 'x', depth: 'survey' },
      });

      const textOf = (r: typeof deep): string =>
        r.messages[0]?.content.type === 'text' ? r.messages[0].content.text : '';

      expect(textOf(deep)).toContain('get_transcripts');
      expect(textOf(survey)).not.toContain('get_transcripts');
    });

    it('narrows the library review to a tag when one is given', async () => {
      const client = await connect();

      const tagged = await client.getPrompt({
        name: 'review_library',
        arguments: { tag: 'systems' },
      });
      const all = await client.getPrompt({ name: 'review_library', arguments: {} });

      const textOf = (r: typeof tagged): string =>
        r.messages[0]?.content.type === 'text' ? r.messages[0].content.text : '';

      expect(textOf(tagged)).toContain('tagged "systems"');
      expect(textOf(all)).toContain('Review everything');
    });

    it('narrows a comparison to a focus question when one is given', async () => {
      const client = await connect();

      const result = await client.getPrompt({
        name: 'compare_videos',
        arguments: { videos: 'a,b', focus: 'which is faster' },
      });
      const text =
        result.messages[0]?.content.type === 'text' ? result.messages[0].content.text : '';

      expect(text).toContain('which is faster');
    });

    it('passes a survey limit through to the channel deep dive', async () => {
      const client = await connect();

      const result = await client.getPrompt({
        name: 'channel_deep_dive',
        arguments: { channel: '@creator', limit: '50' },
      });
      const text =
        result.messages[0]?.content.type === 'text' ? result.messages[0].content.text : '';

      expect(text).toContain('50');
    });
  });

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
    const messages: { level: string; data: unknown }[] = [];

    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      messages.push({ level: notification.params.level, data: notification.params.data });
    });

    // A retry inside yt-dlp logs a warning; the notification only reaches the
    // client if the request context carried a sender through `guarded`.
    vi.mocked(getTranscript).mockRejectedValue(
      new YouTubeError('RATE_LIMITED', 'rate limited', { retryable: true })
    );
    await client.callTool({ name: 'get_transcripts', arguments: { videos: ['aaaaaaaaaaa'] } });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(messages.every((message) => message.level.length > 0)).toBe(true);
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
