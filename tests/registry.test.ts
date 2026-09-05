import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { jpeg } from './fixtures/images.js';

vi.mock('../src/utils/image-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/image-fetch.js')>();
  return { ...actual, fetchImage: vi.fn() };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});

import { fetchImage } from '../src/utils/image-fetch.js';
import { TOOLS } from '../src/registry/index.js';
import { createServer } from '../src/index.js';

/**
 * The registry is data, so the transport gate can be checked tool by tool
 * without booting a server — and then checked against a booted one, so a tool
 * declared local-only is provably absent from the remote listing.
 */

async function connect(mode: 'stdio' | 'http'): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'registry-test', version: '1.0.0' });
  await Promise.all([createServer(mode).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function toolNames(mode: 'stdio' | 'http'): Promise<string[]> {
  const client = await connect(mode);
  const listed = await client.listTools();
  await client.close();
  return listed.tools.map((tool) => tool.name);
}

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'registry-'));
  process.env.TEST_HOME = home;
});

afterAll(async () => {
  delete process.env.TEST_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('tool registry', () => {
  it('gives every tool a unique name', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('registers every tool on stdio, in registry order', async () => {
    expect(await toolNames('stdio')).toEqual(TOOLS.map((tool) => tool.name));
  });

  it('withholds every local-only tool from the HTTP transport, by name', async () => {
    const remote = new Set(await toolNames('http'));
    for (const tool of TOOLS) {
      expect(remote.has(tool.name), `${tool.name} (${tool.mode})`).toBe(tool.mode === 'all');
    }
  });

  // get_thumbnail is the one tool with a local handler: on stdio it may read
  // what fetch_channel_thumbnails saved, over HTTP it never touches the disk.
  it.each(['stdio', 'http'] as const)(
    'serves get_thumbnail on %s through its own handler',
    async (mode) => {
      vi.mocked(fetchImage).mockResolvedValue({
        bytes: Buffer.from(jpeg(1280, 720)),
        contentType: 'image/jpeg',
        url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      });

      const client = await connect(mode);
      const result = await client.callTool({
        name: 'get_thumbnail',
        arguments: { video: 'dQw4w9WgXcQ' },
      });
      await client.close();

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ width: 1280, fromDisk: false });
    }
  );
});
