import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { baseEnv, ENTRY_POINT, freshHome, stdioServerParameters } from './env.js';

export { ENTRY_POINT, freshHome };

/**
 * Drives the built server the way a real client does.
 *
 * Every server gets the environment described in env.ts: its own HOME, and the
 * cookie settings of the runner passed through so a machine YouTube bot-checks
 * can still run the per-video specs with a signed-in session.
 */

export interface ServerHandle {
  client: Client;
  home: string;
  /** Lines the server wrote to stderr so far. */
  stderr: () => string;
  /** Kills the process outright, as a crashed editor would. */
  kill: () => void;
  close: () => Promise<void>;
}

export interface StartOptions {
  home?: string;
  env?: Record<string, string>;
}

/** The built server over stdio. */
export async function startStdioServer(options: StartOptions = {}): Promise<ServerHandle> {
  const home = options.home ?? (await freshHome());
  const transport = new StdioClientTransport(stdioServerParameters(home, options.env));
  const logs: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));

  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);

  return {
    client,
    home,
    stderr: () => logs.join(''),
    kill: () => {
      if (transport.pid !== null) process.kill(transport.pid, 'SIGKILL');
    },
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

/** The built server through a symlink, the way npm installs a bin. */
export async function startStdioServerViaSymlink(): Promise<ServerHandle> {
  const home = await freshHome();
  const link = join(home, 'bin', 'youtube-knowledge-mcp');
  await mkdir(dirname(link), { recursive: true });
  await symlink(ENTRY_POINT, link);
  const transport = new StdioClientTransport(stdioServerParameters(home, {}, link));
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    home,
    stderr: () => '',
    kill: () => undefined,
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}

export interface HttpServerHandle {
  client: Client;
  base: string;
  token: string;
  home: string;
  stderr: () => string;
  /** A raw request, for the negative cases the client cannot express. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

/** The built server over Streamable HTTP, bound to loopback with a token. */
export async function startHttpServer(
  env: Record<string, string> = {},
  options: { authenticate?: boolean } = {}
): Promise<HttpServerHandle> {
  const home = await freshHome();
  const port = await freePort();
  const token = 'e2e-secret-token';
  const child = spawn(process.execPath, [ENTRY_POINT, '--http'], {
    env: baseEnv(home, {
      PORT: String(port),
      MCP_BIND_HOST: '127.0.0.1',
      MCP_AUTH_TOKEN: token,
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      ...env,
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const logs: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, child);

  const authenticate = options.authenticate ?? true;
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: authenticate ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: 'e2e-http', version: '1.0.0' });
  if (authenticate) await client.connect(transport);

  return {
    client,
    base,
    token,
    home,
    stderr: () => logs.join(''),
    fetch: (path, init) => fetch(`${base}${path}`, init),
    close: async () => {
      await client.close().catch(() => undefined);
      child.kill('SIGTERM');
      await new Promise((done) => child.once('exit', done));
    },
  };
}

async function waitForHealth(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`server exited with ${child.exitCode} before listening`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error('server did not start listening within 30s');
}

/** Starts a server that refuses to boot and returns its exit code and stderr. */
export async function startHttpServerExpectingExit(
  env: Record<string, string>
): Promise<{ code: number | null; stderr: string }> {
  const home = await freshHome();
  const child = spawn(process.execPath, [ENTRY_POINT, '--http'], {
    env: baseEnv(home, { PORT: String(await freePort()), ...env }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const logs: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  const code = await new Promise<number | null>((done) => child.once('exit', done));
  await rm(home, { recursive: true, force: true });
  return { code, stderr: logs.join('') };
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
  raw: CallToolResult;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolOutcome> {
  const raw = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = raw.content[0];
  const text = first?.type === 'text' ? first.text : '';
  const structured = raw.structuredContent ?? {};
  return { isError: raw.isError === true, text, structured, raw };
}

/** A tool call that must succeed; the text is included in the failure so the cause is visible. */
export async function callToolOk(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolOutcome> {
  const outcome = await callTool(client, name, args);
  expect(outcome.isError, `${name} failed: ${outcome.text}`).toBe(false);
  return outcome;
}

/**
 * A fake yt-dlp on PATH that records every invocation and answers nothing.
 * Used to prove a request was refused before anything spawned: the record
 * stays empty.
 */
export async function recordingYtDlp(
  home: string
): Promise<{ path: string; calls: () => Promise<string> }> {
  const bin = join(home, 'shim');
  const log = join(home, 'yt-dlp-calls.log');
  await mkdir(bin, { recursive: true });
  const shim = join(bin, 'yt-dlp');
  await writeFile(shim, `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
  await chmod(shim, 0o755);
  return {
    path: [bin, process.env.PATH].filter((part) => part !== undefined).join(':'),
    calls: async () => readFile(log, 'utf-8').catch(() => ''),
  };
}

/** The text of the first resource content, or the failure that it carried none. */
export function resourceText(result: ReadResourceResult): string {
  const first = result.contents[0];
  if (first === undefined || !('text' in first))
    throw new Error('resource carried no text content');
  return first.text;
}

export async function removeHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true });
}
