import { describe, it, expect } from 'vitest';
import { removeHome, startHttpServer, startHttpServerExpectingExit } from './harness.js';

/** The HTTP transport's deployment behaviour, over real sockets. */
describe('http transport', () => {
  it('requires the token, names the metadata document, and withholds local tools', async () => {
    const server = await startHttpServer();
    try {
      const missing = await server.fetch('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'x', version: '1' },
          },
        }),
      });
      expect(missing.status).toBe(401);
      expect(missing.headers.get('www-authenticate')).toContain(
        `${server.base}/.well-known/oauth-protected-resource`
      );

      const wrong = await server.fetch('/mcp', {
        method: 'GET',
        headers: { authorization: 'Bearer nope' },
      });
      expect(wrong.status).toBe(401);

      const names = (await server.client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('save_to_library');
      expect(names).toContain('get_thumbnail');

      for (const response of [missing, await server.fetch('/health')]) {
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('x-powered-by')).toBeNull();
      }

      const health = (await (await server.fetch('/health')).json()) as Record<string, unknown>;
      expect(Object.keys(health)).toEqual(['status']);
      const detailed = (await (
        await server.fetch('/health', { headers: { authorization: `Bearer ${server.token}` } })
      ).json()) as Record<string, unknown>;
      expect(detailed).toMatchObject({
        version: expect.any(String) as string,
        sessions: expect.any(Number) as number,
      });
    } finally {
      await server.close();
      await removeHome(server.home);
    }
  });

  it('ignores a spoofed X-Forwarded-For unless a proxy is trusted, and caps the body', async () => {
    const strict = await startHttpServer(
      { MCP_RATE_LIMIT: '2', MCP_MAX_BODY_BYTES: '2048' },
      { authenticate: false }
    );
    try {
      const hit = (forwarded: string): Promise<Response> =>
        strict.fetch('/health', { headers: { 'x-forwarded-for': forwarded } });
      await hit('1.1.1.1');
      await hit('2.2.2.2');
      expect((await hit('3.3.3.3')).status).toBe(429);
    } finally {
      await strict.close();
      await removeHome(strict.home);
    }

    const trusting = await startHttpServer(
      { MCP_RATE_LIMIT: '2', MCP_TRUST_PROXY: '1' },
      { authenticate: false }
    );
    try {
      const hit = (forwarded: string): Promise<Response> =>
        trusting.fetch('/health', { headers: { 'x-forwarded-for': forwarded } });
      await hit('1.1.1.1');
      await hit('1.1.1.1');
      expect((await hit('2.2.2.2')).status).not.toBe(429);
    } finally {
      await trusting.close();
      await removeHome(trusting.home);
    }

    const capped = await startHttpServer({ MCP_MAX_BODY_BYTES: '1024' });
    try {
      const big = await capped.fetch('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${capped.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'x',
          params: { pad: 'x'.repeat(4096) },
        }),
      });
      expect(big.status).toBe(413);
    } finally {
      await capped.close();
      await removeHome(capped.home);
    }
  });

  it('refuses to start exposed without a token', async () => {
    const { code, stderr } = await startHttpServerExpectingExit({ MCP_BIND_HOST: '0.0.0.0' });
    expect(code).toBe(1);
    expect(stderr).toContain('MCP_AUTH_TOKEN');
    expect(stderr).toContain('MCP_ALLOW_UNAUTHENTICATED');
  });
});
