import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TOOLS } from '../src/registry/index.js';
import { createServer } from '../src/index.js';

/**
 * The registry is data, so the transport gate can be checked tool by tool
 * without booting a server — and then checked against a booted one, so a tool
 * declared local-only is provably absent from the remote listing.
 */

async function toolNames(mode: 'stdio' | 'http'): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'registry-test', version: '1.0.0' });
  await Promise.all([createServer(mode).connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  await client.close();
  return listed.tools.map((tool) => tool.name);
}

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
});
