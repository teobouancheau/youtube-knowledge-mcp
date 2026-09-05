import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const run = promisify(execFile);
const enabled = process.env.E2E_DOCKER === '1';

/**
 * A cold build installs ffmpeg and yt-dlp from apt and pip, which takes several
 * minutes on a laptop; the suite-wide timeout is sized for yt-dlp calls, not for
 * that, so this spec carries its own.
 */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/** The image, built and run with a token: the deployment path the README documents. */
describe.skipIf(!enabled)('docker image', () => {
  it(
    'builds, serves health, and answers an authenticated client as the node user',
    async () => {
      const tag = 'youtube-knowledge-mcp:e2e';
      await run('docker', ['build', '-t', tag, '.'], { maxBuffer: 64 * 1024 * 1024 });
      const token = 'docker-e2e-token';
      const { stdout } = await run('docker', [
        'run',
        '-d',
        '--rm',
        '-p',
        '0:10000',
        '-e',
        `MCP_AUTH_TOKEN=${token}`,
        tag,
      ]);
      const container = stdout.trim();
      try {
        const { stdout: portLine } = await run('docker', ['port', container, '10000']);
        const port = portLine.trim().split(':').pop();
        const base = `http://127.0.0.1:${port}`;

        let healthy = false;
        for (let attempt = 0; attempt < 60 && !healthy; attempt++) {
          healthy = await fetch(`${base}/health`)
            .then((r) => r.ok)
            .catch(() => false);
          if (!healthy) await new Promise((done) => setTimeout(done, 1000));
        }
        expect(healthy).toBe(true);

        const client = new Client({ name: 'docker-e2e', version: '1.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          })
        );
        expect((await client.listTools()).tools.length).toBe(15);
        await client.close();

        const { stdout: user } = await run('docker', ['exec', container, 'whoami']);
        expect(user.trim()).toBe('node');
      } finally {
        await run('docker', ['stop', container]).catch(() => undefined);
      }
    },
    BUILD_TIMEOUT_MS
  );
});
