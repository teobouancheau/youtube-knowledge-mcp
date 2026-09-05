import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  callTool,
  freshHome,
  recordingYtDlp,
  removeHome,
  startStdioServer,
  type ServerHandle,
} from './harness.js';

/**
 * The refusals, against the built server, with a recording yt-dlp on PATH:
 * every case below must be refused before anything spawns, and the record
 * must stay empty.
 */
let server: ServerHandle;
let calls: () => Promise<string>;

beforeAll(async () => {
  const home = await freshHome();
  const shim = await recordingYtDlp(home);
  calls = shim.calls;
  server = await startStdioServer({ home, env: { PATH: shim.path } });
});

afterAll(async () => {
  await server.close();
  await removeHome(server.home);
});

/** The boot preflight asks yt-dlp for its version; every other spawn is a request. */
async function spawnsBeyondPreflight(): Promise<string[]> {
  const lines = (await calls()).split('\n').filter((line) => line.length > 0);
  return lines.filter((line) => line !== '--version');
}

describe('security', () => {
  it.each([
    ['a flag as a listing URL', 'fetch_videos', { url: '--config-locations=/tmp/x' }],
    ['a cloud metadata address', 'get_channel_info', { channel: 'http://169.254.169.254/latest/' }],
    ['a look-alike host', 'get_channel_info', { channel: 'https://youtube.com.evil.example/@x' }],
    ['another host as a playlist', 'get_playlist_info', { url: 'https://example.com/list' }],
    [
      'a traversal video id',
      'save_to_library',
      { videoId: '../../x', title: 't', content: 'c', contentType: 'summary' },
    ],
    [
      'an output directory outside home',
      'extract_frame',
      { video: 'dQw4w9WgXcQ', timestamp: '1', outputDir: '/etc' },
    ],
    [
      'a runaway pattern',
      'search_transcript',
      { video: 'dQw4w9WgXcQ', query: '(a+)+$', regex: true },
    ],
    ['an image host off the allowlist', 'get_thumbnail', { video: 'not-a-video-id-at-all' }],
  ])('refuses %s without spawning yt-dlp', async (_label, tool, args) => {
    const result = await callTool(server.client, tool, args);
    expect(result.isError).toBe(true);
    // Refused either by the tool's schema (the SDK reports that as a validation
    // error) or by the handler's own boundary check (typed INVALID_INPUT).
    expect(result.text).toMatch(/^\[INVALID_INPUT\]|Input validation error/);
    expect(await spawnsBeyondPreflight()).toEqual([]);
  });

  it('never surfaces a local path or the yt-dlp command line in an error', async () => {
    // The shim exits 1 for any real call, so this exercises the generic failure path.
    const result = await callTool(server.client, 'get_video_info', { video: 'dQw4w9WgXcQ' });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(server.home);
    expect(result.text).not.toContain('--socket-timeout');
    expect(await spawnsBeyondPreflight()).toHaveLength(1);
  });
});
