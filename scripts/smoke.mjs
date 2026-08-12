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
 * The manifest is checked once, then the whole handshake is repeated through a
 * symlink to the entry point. That second launch is not redundant: npm and npx
 * install the `bin` as a link in `node_modules/.bin`, so every real client
 * starts the server that way, and Node then reports the link in
 * `process.argv[1]` while resolving `import.meta.url` to the real file. Version
 * 1.2.0 shipped an `argv[1] === import.meta.url` guard around `main()` and
 * exited 0 without output for every user, while this test — which launched the
 * entry point directly — stayed green.
 *
 * Runs without yt-dlp installed — listing tools never shells out.
 */
import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENTRY_POINT = 'dist/cli.js';

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

/** Completes a handshake against one launch path and returns the tool manifest. */
async function listToolsVia(scriptPath, label) {
  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [scriptPath, '--stdio'],
    stderr: 'inherit',
  });

  try {
    await client.connect(transport);
    return (await client.listTools()).tools;
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : error}`);
    return [];
  } finally {
    await client.close().catch(() => undefined);
  }
}

const tools = await listToolsVia(ENTRY_POINT, 'direct launch failed');
check(tools.length > 0, 'server registered no tools');

for (const tool of tools) {
  check(/^[a-z][a-z0-9_]*$/.test(tool.name), `tool "${tool.name}" is not snake_case`);
  check(Boolean(tool.description), `tool "${tool.name}" has no description`);
  check(Boolean(tool.inputSchema), `tool "${tool.name}" has no inputSchema`);
  check(Boolean(tool.annotations), `tool "${tool.name}" has no annotations`);
}

const names = tools.map((t) => t.name).sort();
check(new Set(names).size === names.length, 'duplicate tool names in the manifest');

const linkDir = mkdtempSync(join(tmpdir(), 'ykm-smoke-'));
const link = join(linkDir, 'youtube-knowledge-mcp');
try {
  symlinkSync(resolve(ENTRY_POINT), link);
  const linked = await listToolsVia(link, 'launch through a symlinked bin failed');
  check(
    linked.length === tools.length,
    `symlinked launch listed ${linked.length} tools, direct launch listed ${tools.length}`
  );
} finally {
  rmSync(linkDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('\n✗ smoke test failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ handshake ok direct and through a symlinked bin, ${tools.length} tools listed`);
console.log(`  ${names.join(', ')}`);
