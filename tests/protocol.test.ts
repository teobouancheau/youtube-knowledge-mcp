import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/index.js';

/**
 * Protocol-level tests.
 *
 * The unit suite exercises handlers directly, which cannot see registration
 * mistakes: a malformed schema, a missing annotation, a tool leaking into the
 * remote surface, or a name that collides. These drive the real server through
 * a real MCP client over an in-memory transport, so what is asserted is exactly
 * what a client sees.
 */

async function connect(mode: 'stdio' | 'http'): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(mode);
  const client = new Client({ name: 'protocol-test', version: '1.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

let stdioTools: Tool[];
let httpTools: Tool[];

beforeAll(async () => {
  stdioTools = (await (await connect('stdio')).listTools()).tools;
  httpTools = (await (await connect('http')).listTools()).tools;
});

describe('tool manifest', () => {
  it('registers every tool with a unique name', () => {
    const names = stdioTools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names every tool in snake_case', () => {
    for (const tool of stdioTools) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('names every tool verb first', () => {
    // A tool name is an action the model is choosing to take, so it reads as
    // one: verb + what it acts on. `health_check` was the sole noun-first name
    // and became `check_health` before it ever shipped.
    const VERBS = new Set([
      'search',
      'fetch',
      'get',
      'list',
      'check',
      'download',
      'save',
      'update',
      'delete',
      'rebuild',
      'extract',
      'export',
      'digest',
      'build',
      'ask',
      'repair',
    ]);

    for (const tool of stdioTools) {
      const verb = tool.name.split('_')[0];
      expect(VERBS.has(verb ?? ''), `${tool.name} does not start with a verb`).toBe(true);
    }
  });

  it('never prefixes a tool name with the service name', () => {
    // Clients already namespace tools by server, so a `youtube_` prefix repeats
    // what the client knows and spends tokens on it in every request.
    for (const tool of stdioTools) {
      expect(tool.name, `${tool.name} carries a redundant service prefix`).not.toMatch(
        /^(youtube|yt|ytdlp)_/
      );
    }
  });

  it('gives every tool a title, description, input schema and annotations', () => {
    for (const tool of stdioTools) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeDefined();
      expect(tool.annotations, `${tool.name} annotations`).toBeDefined();
    }
  });

  it('declares an output schema on every tool', () => {
    // The single biggest conformance gap this release closes.
    for (const tool of stdioTools) {
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
    }
  });

  it('sets all four annotation hints explicitly on every tool', () => {
    for (const tool of stdioTools) {
      const annotations = tool.annotations ?? {};
      for (const hint of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ] as const) {
        expect(typeof annotations[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
    }
  });

  it('marks only genuinely destructive tools as destructive', () => {
    const destructive = stdioTools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name)
      .sort();

    // Overwriting a saved note and replacing a tag set both discard content the
    // user cannot recover, so they belong here alongside the outright delete.
    expect(destructive).toEqual([
      'build_brain',
      'delete_brain',
      'delete_channel_thumbnails',
      'delete_library_item',
      'repair_store',
      'save_brain_profile',
      'save_to_library',
      'update_library_tags',
    ]);
  });

  it('never describes destructive behaviour while claiming to be non-destructive', () => {
    // The invariant behind the annotation, rather than a hand-maintained list:
    // a client uses destructiveHint to decide whether to confirm before acting,
    // so an annotation that understates the risk is worse than a missing one.
    const admitsDataLoss = /\boverwrit\w*|\bdelete[sd]?\b|\bdiscard\w*|\breplaces? all\b/i;

    for (const tool of stdioTools) {
      if (!admitsDataLoss.test(tool.description ?? '')) continue;

      expect(
        tool.annotations?.destructiveHint,
        `${tool.name} describes destructive behaviour but is not marked destructive`
      ).toBe(true);
    }
  });

  it('agrees on idempotency between tools that behave the same way', () => {
    // All of these write to a deterministic path and overwrite it, so repeating
    // the call leaves the same state. download_video disagreed until 1.2.0.
    for (const name of [
      'download_video',
      'extract_clip',
      'extract_audio_clip',
      'export_subtitles',
    ]) {
      const tool = stdioTools.find((candidate) => candidate.name === name);
      expect(tool?.annotations?.idempotentHint, name).toBe(true);
    }
  });

  it('never marks a writing tool as read-only', () => {
    const writers = [
      'save_to_library',
      'delete_library_item',
      'update_library_tags',
      'download_video',
      'extract_clip',
      'export_subtitles',
    ];

    for (const name of writers) {
      const tool = stdioTools.find((candidate) => candidate.name === name);
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
    }
  });
});

describe('transport-mode gating', () => {
  it('withholds every filesystem-backed tool from the remote surface', () => {
    // A remote deployment must not expose the caller's disk.
    const localOnly = [
      'save_to_library',
      'list_library',
      'get_library_item',
      'search_library',
      'delete_library_item',
      'update_library_tags',
      'rebuild_library_index',
      'download_video',
      'extract_clip',
      'extract_audio_clip',
      'extract_clips',
      'extract_frame',
      'export_subtitles',
      'build_brain',
      'ask_brain',
      'list_brains',
      'get_brain_info',
      'save_brain_profile',
      'delete_brain',
      'fetch_channel_thumbnails',
      'list_channel_thumbnails',
      'delete_channel_thumbnails',
    ];

    const remoteNames = httpTools.map((tool) => tool.name);
    for (const name of localOnly) {
      expect(remoteNames, `${name} must not be exposed over HTTP`).not.toContain(name);
    }
  });

  it('exposes the read-only YouTube tools in both modes', () => {
    const remoteSafe = [
      'search_videos',
      'fetch_videos',
      'get_video_info',
      'get_transcript',
      'search_transcript',
      'get_chapters',
      'get_comments',
      'get_channel_info',
      'search_channels',
      'get_playlist_info',
      'list_formats',
      'get_transcripts',
      'digest_playlist',
      'check_health',
      'get_thumbnail',
    ];

    const remoteNames = httpTools.map((tool) => tool.name);
    for (const name of remoteSafe) {
      expect(remoteNames, name).toContain(name);
    }
  });

  it('exposes strictly more tools locally than remotely', () => {
    expect(stdioTools.length).toBeGreaterThan(httpTools.length);
  });
});

describe('additivity against v1.1.1', () => {
  /**
   * Every tool the previous release shipped. A minor version must not remove or
   * rename any of them, and this is what enforces that promise.
   */
  const V1_TOOLS = [
    'search_videos',
    'fetch_videos',
    'get_video_info',
    'get_transcript',
    'get_chapters',
    'get_comments',
    'get_channel_info',
    'search_channels',
    'get_playlist_info',
    'list_formats',
    'save_to_library',
    'list_library',
    'download_video',
  ];

  it('still registers every v1 tool under its original name', () => {
    const names = stdioTools.map((tool) => tool.name);
    for (const name of V1_TOOLS) {
      expect(names, name).toContain(name);
    }
  });

  it('still accepts every v1 required parameter', () => {
    const v1Required: Record<string, string[]> = {
      search_videos: ['query'],
      fetch_videos: ['url'],
      get_video_info: ['video'],
      get_transcript: ['video'],
      get_chapters: ['video'],
      get_comments: ['video'],
      get_channel_info: ['channel'],
      search_channels: ['query'],
      get_playlist_info: ['url'],
      list_formats: ['video'],
      save_to_library: ['videoId', 'title', 'content'],
      download_video: ['video'],
    };

    for (const [name, params] of Object.entries(v1Required)) {
      const tool = stdioTools.find((candidate) => candidate.name === name);
      const properties = Object.keys(tool?.inputSchema.properties ?? {});
      for (const param of params) {
        expect(properties, `${name}.${param}`).toContain(param);
      }
    }
  });

  it('has not made any previously optional v1 parameter required', () => {
    // Requiring something that used to default would break existing callers.
    const stillOptional: Record<string, string[]> = {
      search_videos: ['limit'],
      fetch_videos: ['limit'],
      get_transcript: ['language'],
      get_comments: ['limit'],
      search_channels: ['limit'],
      list_library: ['tag'],
      download_video: ['quality', 'formatId', 'outputDir'],
      save_to_library: ['contentType', 'channel', 'tags'],
    };

    for (const [name, params] of Object.entries(stillOptional)) {
      const tool = stdioTools.find((candidate) => candidate.name === name);
      const required = tool?.inputSchema.required ?? [];
      for (const param of params) {
        expect(required, `${name}.${param} must stay optional`).not.toContain(param);
      }
    }
  });
});

describe('prompts', () => {
  it('exposes the documented workflows', async () => {
    const { prompts } = await (await connect('stdio')).listPrompts();
    const names = prompts.map((prompt) => prompt.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'summarize_video',
        'extract_skill',
        'compare_videos',
        'research_topic',
        'channel_deep_dive',
        'clip_from_quote',
      ])
    );
  });

  it('describes every prompt', async () => {
    const { prompts } = await (await connect('stdio')).listPrompts();
    for (const prompt of prompts) {
      expect(prompt.description, prompt.name).toBeTruthy();
    }
  });

  it('renders a prompt with its arguments substituted', async () => {
    const client = await connect('stdio');
    const result = await client.getPrompt({
      name: 'clip_from_quote',
      arguments: { video: 'dQw4w9WgXcQ', quote: 'never gonna give you up' },
    });

    const [message] = result.messages;
    expect(message?.content.type).toBe('text');
    const text = message?.content.type === 'text' ? message.content.text : '';

    expect(text).toContain('dQw4w9WgXcQ');
    expect(text).toContain('never gonna give you up');
    expect(text).toContain('search_transcript');
    expect(text).toContain('extract_clip');
  });

  it('withholds library prompts from the remote surface', async () => {
    const { prompts } = await (await connect('http')).listPrompts();
    expect(prompts.map((prompt) => prompt.name)).not.toContain('review_library');
  });

  it('withholds brain prompts from the remote surface', async () => {
    const { prompts } = await (await connect('http')).listPrompts();
    const names = prompts.map((prompt) => prompt.name);

    expect(names).not.toContain('create_brain');
    expect(names).not.toContain('ask_creator');
  });
});

describe('resources', () => {
  it('exposes a transcript template in both modes', async () => {
    for (const mode of ['stdio', 'http'] as const) {
      const { resourceTemplates } = await (await connect(mode)).listResourceTemplates();
      expect(resourceTemplates.map((template) => template.uriTemplate)).toContain(
        'youtube://transcript/{videoId}'
      );
    }
  });

  it('exposes brains only locally', async () => {
    const local = await (await connect('stdio')).listResourceTemplates();
    const remote = await (await connect('http')).listResourceTemplates();

    const uri = 'youtube://brain/{channelId}/{part}';
    expect(local.resourceTemplates.map((template) => template.uriTemplate)).toContain(uri);
    expect(remote.resourceTemplates.map((template) => template.uriTemplate)).not.toContain(uri);
  });

  it('exposes the library only locally', async () => {
    const local = await (await connect('stdio')).listResourceTemplates();
    const remote = await (await connect('http')).listResourceTemplates();

    const uri = 'youtube://library/{videoId}/{contentType}';
    expect(local.resourceTemplates.map((template) => template.uriTemplate)).toContain(uri);
    expect(remote.resourceTemplates.map((template) => template.uriTemplate)).not.toContain(uri);
  });
});

describe('error reporting', () => {
  it('reports a bad argument as an isError result, not a protocol failure', async () => {
    const client = await connect('stdio');

    const result = await client.callTool({
      name: 'get_transcript',
      arguments: { video: 'dQw4w9WgXcQ', language: 'not a language' },
    });

    // A tool error the model can read and recover from, rather than a thrown
    // JSON-RPC error that ends the turn.
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0]?.text).toContain('[INVALID_INPUT]');
  });

  it('prefixes every tool error with its code and never leaks a stack trace', async () => {
    const client = await connect('stdio');

    const result = await client.callTool({
      name: 'get_transcript',
      arguments: { video: 'dQw4w9WgXcQ', startTime: '30', endTime: '10' },
    });

    const content = result.content as { type: string; text: string }[];
    expect(content[0]?.text).toMatch(/^\[[A-Z_]+\]/);
    expect(content[0]?.text).not.toContain('    at ');
  });
});

describe('documented surface', () => {
  /**
   * The README states how many tools there are and how they split across the
   * two transports. Those numbers are the first thing a reader trusts and the
   * easiest thing to forget, so they are checked against the server rather than
   * maintained by hand.
   */
  async function readme(): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL('../README.md', import.meta.url), 'utf-8');
  }

  it('never names a parameter a tool does not take', async () => {
    const text = await readme();
    const byName = new Map(stdioTools.map((tool) => [tool.name, tool]));

    // The column is headed "Key parameters", so a row may leave one out. What
    // it may not do is name one that was renamed or removed — a reader cannot
    // tell that from an omission, and will pass it.
    const rows = text.matchAll(/^\| `(\w+)`\s*\|([^|]*)\|/gm);
    let checked = 0;

    for (const [, name, parameters] of rows) {
      const tool = byName.get(name ?? '');
      if (tool === undefined) continue;

      const actual = new Set(Object.keys(tool.inputSchema.properties ?? {}));
      const documented = [...(parameters ?? '').matchAll(/`(\w+)`/g)].map((match) => match[1]);

      for (const parameter of documented) {
        expect(actual.has(parameter ?? ''), `${name} has no parameter "${parameter}"`).toBe(true);
      }
      checked++;
    }

    expect(checked, 'no tool rows found in the README').toBeGreaterThan(20);
  });

  it('counts tools the way the README says it does', async () => {
    const claimed =
      /(\d+) tools\. The (\d+) read-only ones work over both transports; the (\d+)/.exec(
        await readme()
      );

    expect(
      claimed,
      'the README no longer states its tool counts in the expected form'
    ).not.toBeNull();

    const [total, remote, local] = [claimed?.[1], claimed?.[2], claimed?.[3]].map(Number);

    expect(total, 'total tools').toBe(stdioTools.length);
    expect(remote, 'tools available over HTTP').toBe(httpTools.length);
    expect(local, 'tools registered only locally').toBe(stdioTools.length - httpTools.length);
  });
});
