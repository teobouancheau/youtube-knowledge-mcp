import { describe, it, expect } from 'vitest';
import { callTool, callToolOk, removeHome, startStdioServer } from './harness.js';
import { VIDEO } from './fixtures.js';

/**
 * Runs only when the runner's environment configures cookies; otherwise it
 * reports that plainly (and fails when E2E_REQUIRE_COOKIES=1 says the lane
 * must have them) rather than passing on nothing.
 */
const configured =
  process.env.YOUTUBE_MCP_COOKIES_FROM_BROWSER !== undefined ||
  process.env.YOUTUBE_MCP_COOKIES_FILE !== undefined;

describe('signed-in access', () => {
  it('is configured, or says so', () => {
    if (!configured && process.env.E2E_REQUIRE_COOKIES === '1') {
      throw new Error('E2E_REQUIRE_COOKIES=1 but no cookie setting is configured');
    }
    expect(true).toBe(true);
  });

  it.skipIf(!configured)('reads a video with cookies and never echoes the setting', async () => {
    const server = await startStdioServer();
    try {
      const info = await callToolOk(server.client, 'get_video_info', { video: VIDEO.id });
      expect(info.structured).toMatchObject({ id: VIDEO.id });

      const health = await callToolOk(server.client, 'check_health');
      expect(health.structured.cookies).not.toBe('none');

      // Whatever was configured must never come back out. With browser cookies
      // there is no path to leak; the sentinel keeps the assertion unconditional.
      const failure = await callTool(server.client, 'get_video_info', { video: 'aaaaaaaaaaa' });
      const secret = process.env.YOUTUBE_MCP_COOKIES_FILE ?? '\u0000never-present';
      const leaks = [health.text, server.stderr(), failure.text].filter((text) =>
        text.includes(secret)
      );
      expect(leaks).toEqual([]);
    } finally {
      await server.close();
      await removeHome(server.home);
    }
  });
});
