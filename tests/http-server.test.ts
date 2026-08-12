import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttp, readHttpConfig, type HttpConfig, type HttpServerHandle } from '../src/http.js';

/**
 * Boots the real HTTP transport on an ephemeral port and drives it over the
 * network. Unit tests cover the helpers; this covers the wiring — that auth is
 * actually enforced on every route, that 429 carries Retry-After, and that the
 * health endpoint stays reachable without a token.
 */

const started: HttpServerHandle[] = [];

function boot(overrides: Partial<HttpConfig> = {}): Promise<{ base: string }> {
  const handle = startHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
    ...readHttpConfig(),
    port: 0,
    bindHost: '127.0.0.1',
    ...overrides,
  });
  started.push(handle);
  return handle.ready.then(({ port }) => ({ base: `http://127.0.0.1:${port}` }));
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  },
};

function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.close();
});

describe('HTTP transport authentication', () => {
  it('rejects an unauthenticated request when a token is configured', async () => {
    const { base } = await boot({ authToken: 'secret' });

    const response = await post(base, initialize);

    expect(response.status).toBe(401);
  });

  it('points unauthenticated callers at the resource metadata', async () => {
    const { base } = await boot({ authToken: 'secret' });

    const response = await post(base, initialize);

    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('rejects a wrong token', async () => {
    const { base } = await boot({ authToken: 'secret' });

    const response = await post(base, initialize, { Authorization: 'Bearer wrong' });

    expect(response.status).toBe(401);
  });

  it('accepts the configured token', async () => {
    const { base } = await boot({ authToken: 'secret' });

    const response = await post(base, initialize, { Authorization: 'Bearer secret' });

    expect(response.status).not.toBe(401);
  });

  it('enforces auth on GET and DELETE, not only POST', async () => {
    const { base } = await boot({ authToken: 'secret' });

    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${base}/mcp`, { method });
      expect(response.status, `${method} should require auth`).toBe(401);
    }
  });

  it('stays open when no token is configured, so existing deployments keep working', async () => {
    const { base } = await boot({ authToken: undefined });

    const response = await post(base, initialize);

    expect(response.status).not.toBe(401);
  });
});

describe('HTTP transport rate limiting', () => {
  it('returns 429 with Retry-After once the limit is exceeded', async () => {
    const { base } = await boot({ rateLimit: 2, rateWindowMs: 60_000 });

    await post(base, initialize);
    await post(base, initialize);
    const blocked = await post(base, initialize);

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('advertises the remaining quota', async () => {
    const { base } = await boot({ rateLimit: 5, rateWindowMs: 60_000 });

    const response = await post(base, initialize);

    expect(response.headers.get('ratelimit-limit')).toBe('5');
    expect(response.headers.get('ratelimit-remaining')).toBe('4');
  });
});

describe('HTTP transport sessions', () => {
  it('refuses a request carrying an unknown session ID', async () => {
    const { base } = await boot();

    const response = await post(
      base,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        'mcp-session-id': 'does-not-exist',
      }
    );

    expect(response.status).toBe(400);
  });

  it('rejects new sessions once at capacity rather than growing without bound', async () => {
    const { base } = await boot({ maxSessions: 0 });

    const response = await post(base, initialize);

    expect(response.status).toBe(503);
  });
});

describe('HTTP endpoints', () => {
  it('serves health without a token, since probes cannot carry one', async () => {
    const { base } = await boot({ authToken: 'secret' });

    const response = await fetch(`${base}/health`);
    const body = (await response.json()) as { status: string; sessions: number };

    expect([200, 503]).toContain(response.status);
    expect(body.status).toMatch(/ok|degraded/);
    expect(body.sessions).toBe(0);
  });

  it('publishes OAuth protected-resource metadata', async () => {
    const { base } = await boot({ authToken: 'secret' });

    const response = await fetch(`${base}/.well-known/oauth-protected-resource`);
    const body = (await response.json()) as { bearer_methods_supported: string[] };

    expect(response.status).toBe(200);
    expect(body.bearer_methods_supported).toContain('header');
  });
});
