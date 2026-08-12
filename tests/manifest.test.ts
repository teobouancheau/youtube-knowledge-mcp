import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';

/**
 * Snapshot of the public surface.
 *
 * The manifest is this server's API. Anything that changes a tool name, a
 * parameter, a required field or an annotation shows up here as a diff, which
 * forces the change to be deliberate — and is what keeps a "minor release is
 * additive" promise honest, since removals appear as deletions in review.
 *
 * Update with `npx vitest run -u` when a change is intended.
 */

async function manifest(mode: 'stdio' | 'http'): Promise<unknown> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(mode);
  const client = new Client({ name: 'manifest', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();

  // Descriptions are prose and churn freely; names, parameters and annotations
  // are the contract.
  return tools
    .map((tool) => ({
      name: tool.name,
      parameters: Object.keys(tool.inputSchema.properties ?? {}).sort(),
      required: [...(tool.inputSchema.required ?? [])].sort(),
      hasOutputSchema: tool.outputSchema !== undefined,
      annotations: tool.annotations,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe('tool manifest snapshot', () => {
  it('matches the recorded local surface', async () => {
    await expect(manifest('stdio')).resolves.toMatchSnapshot();
  });

  it('matches the recorded remote surface', async () => {
    await expect(manifest('http')).resolves.toMatchSnapshot();
  });
});
