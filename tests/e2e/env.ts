import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * How every server under test is started: the built entry point, a fresh HOME
 * under the OS temp directory so nothing touches ~/.youtube-knowledge, and the
 * few variables of the runner's environment that yt-dlp needs to reach YouTube.
 *
 * The global setup uses the same definition, so a binary that only works under
 * the real HOME (a per-user pip install, for instance) fails once with a clear
 * message instead of failing every spec.
 */

export const ENTRY_POINT = resolve('dist/cli.js');

declare module 'vitest' {
  export interface ProvidedContext {
    /** Whether YouTube serves per-video data to this address; set by the global setup. */
    perVideo: boolean;
  }
}

const PASSTHROUGH = [
  'PATH',
  'YOUTUBE_MCP_COOKIES_FROM_BROWSER',
  'YOUTUBE_MCP_COOKIES_FILE',
  'YOUTUBE_MCP_PROXY',
  'YOUTUBE_MCP_SLEEP_REQUESTS_S',
];

export function baseEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { HOME: home };
  for (const name of PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

export async function freshHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ykm-e2e-'));
}

/** Parameters for the built server over stdio, from `entry` (the entry point unless a symlink to it). */
export function stdioServerParameters(
  home: string,
  extra: Record<string, string> = {},
  entry: string = ENTRY_POINT
): StdioServerParameters {
  return {
    command: process.execPath,
    args: [entry, '--stdio'],
    env: baseEnv(home, extra),
    stderr: 'pipe',
  };
}
