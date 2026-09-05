import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { TestProject } from 'vitest/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { baseEnv, freshHome, stdioServerParameters } from './env.js';
import { VIDEO } from './fixtures.js';

/**
 * Preconditions, checked once and reported as one failure rather than as a
 * silent skip: the lane exists to prove the server works for real, and a lane
 * that quietly did nothing would prove the opposite.
 *
 * One thing is outside the lane's control: YouTube refuses per-video data to
 * addresses it distrusts (every datacenter, so every CI runner) unless a
 * signed-in session or a proxy is configured. That is probed once through the
 * built server, so the session settings count, and the per-video specs are
 * skipped with a printed reason rather than failing forty times.
 */
const run = promisify(execFile);

const PER_VIDEO_SKIPPED = [
  'Per-video lane: not run.',
  'YouTube answers this address with its bot check, so transcripts, video reads, media and brains are skipped.',
  'Set YOUTUBE_MCP_COOKIES_FILE, YOUTUBE_MCP_COOKIES_FROM_BROWSER or YOUTUBE_MCP_PROXY to run them.',
].join(' ');

/**
 * Reads one video through the built server; undefined when it works, otherwise
 * the error text. Chapters come from the player response, the part YouTube
 * withholds from a distrusted address; the basic info tool survives on the page
 * data alone, so it would report a lane that then fails.
 */
async function probePerVideo(home: string): Promise<string | undefined> {
  const client = new Client({ name: 'e2e-setup', version: '1.0.0' });
  await client.connect(new StdioClientTransport(stdioServerParameters(home)));
  try {
    const raw = (await client.callTool({
      name: 'get_chapters',
      arguments: { video: VIDEO.id },
    })) as CallToolResult;
    if (raw.isError !== true) return undefined;
    const first = raw.content[0];
    return first?.type === 'text' ? first.text : 'get_video_info failed without a message';
  } finally {
    await client.close();
  }
}

async function report(line: string): Promise<void> {
  console.error(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined) await appendFile(summary, `${line}\n`);
}

export default async function setup(project: TestProject): Promise<void> {
  const problems: string[] = [];

  if (process.env.E2E !== '1') {
    problems.push('E2E=1 is not set; this lane talks to YouTube and runs only when asked to.');
  }
  if (!existsSync('dist/cli.js')) problems.push('dist/cli.js is missing; run npm run build first.');

  // Probed under the same isolated HOME a server under test gets, so a binary
  // that only resolves from the real home directory is caught here.
  const home = await freshHome();
  try {
    for (const [binary, flag] of [
      ['yt-dlp', '--version'],
      ['ffmpeg', '-version'],
    ] as const) {
      try {
        await run(binary, [flag], { env: baseEnv(home) });
      } catch {
        problems.push(
          `${binary} is not runnable from PATH under an isolated HOME. A per-user install (pip --user) is not; install it system-wide.`
        );
      }
    }

    if (problems.length > 0) {
      throw new Error(`The end-to-end lane cannot run:\n- ${problems.join('\n- ')}`);
    }

    const failure = await probePerVideo(home);
    if (failure === undefined) {
      project.provide('perVideo', true);
      await report('Per-video lane: enabled.');
    } else if (failure.includes('BOT_CHECK')) {
      project.provide('perVideo', false);
      await report(PER_VIDEO_SKIPPED);
    } else {
      // Anything but the bot check is the server failing to read a video, which
      // is exactly what the lane exists to catch.
      throw new Error(`The built server cannot read a video: ${failure}`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
