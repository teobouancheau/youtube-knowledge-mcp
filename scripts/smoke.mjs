#!/usr/bin/env node
/**
 * Post-build smoke test.
 *
 * Boots the compiled server over stdio as a real MCP client and asserts that the
 * handshake completes and the tool manifest is well formed. This catches the
 * class of breakage unit tests cannot see: a bad build, a broken import, a
 * malformed schema that only fails at registration time, or a stray write to
 * stdout corrupting the JSON-RPC stream.
 *
 * Runs without yt-dlp installed — listing tools never shells out.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js', '--stdio'],
  stderr: 'inherit',
});

const client = new Client({ name: 'smoke-test', version: '1.0.0' });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  check(tools.length > 0, 'server registered no tools');

  for (const tool of tools) {
    check(/^[a-z][a-z0-9_]*$/.test(tool.name), `tool "${tool.name}" is not snake_case`);
    check(Boolean(tool.description), `tool "${tool.name}" has no description`);
    check(Boolean(tool.inputSchema), `tool "${tool.name}" has no inputSchema`);
    check(Boolean(tool.annotations), `tool "${tool.name}" has no annotations`);
  }

  const names = tools.map((t) => t.name).sort();
  check(new Set(names).size === names.length, 'duplicate tool names in the manifest');

  console.log(`✓ handshake ok, ${tools.length} tools listed`);
  console.log(`  ${names.join(', ')}`);
} catch (error) {
  failures.push(`connect/listTools threw: ${error instanceof Error ? error.message : error}`);
} finally {
  await client.close().catch(() => undefined);
}

if (failures.length > 0) {
  console.error('\n✗ smoke test failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
