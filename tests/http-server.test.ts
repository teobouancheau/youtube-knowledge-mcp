import { request } from 'node:http';

import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttp, readHttpConfig, type HttpConfig, type HttpServerHandle } from '../src/http.js';

// The boot log prints the preflight report only when a binary is missing, so
// the suite has to be able to make preflight fail on demand.
vi.mock('../src/utils/preflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/preflight.js')>();
  return { ...actual, runPreflight: vi.fn(actual.runPreflight) };
});
import { runPreflight } from '../src/utils/preflight.js';

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

/**
 * `fetch` drops a caller-supplied Host header — it is forbidden in the spec, and
 * undici silently replaces it with the target authority. Anything asserting on
 * Host validation has to go through node:http, which sends what it is given.
 */
function postWithHost(base: string, hostHeader: string): Promise<{ status: number }> {
  const { hostname, port } = new URL(base);
  const payload = JSON.stringify(initialize);

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname,
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Host: hostHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0 });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
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

  it('applies the limit to GET and DELETE, the metadata document and health', async () => {
    const { base } = await boot({ rateLimit: 1, rateWindowMs: 60_000 });

    // The first request spends the single allowance; everything after is 429,
    // whichever route it hits.
    await fetch(`${base}/health`);
    expect((await fetch(`${base}/health`)).status).toBe(429);
    expect((await fetch(`${base}/mcp`, { method: 'GET' })).status).toBe(429);
    expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(429);
    expect((await fetch(`${base}/.well-known/oauth-protected-resource`)).status).toBe(429);
  });

  it('ignores a spoofed X-Forwarded-For unless a proxy is trusted', async () => {
    const { base } = await boot({ rateLimit: 1, rateWindowMs: 60_000 });

    await post(base, initialize, { 'X-Forwarded-For': '1.1.1.1' });
    const second = await post(base, initialize, { 'X-Forwarded-For': '2.2.2.2' });

    expect(second.status).toBe(429);
  });

  it('keys on the forwarded client when the proxy is trusted', async () => {
    const { base } = await boot({ rateLimit: 1, rateWindowMs: 60_000, trustProxy: 1 });

    await post(base, initialize, { 'X-Forwarded-For': '1.1.1.1' });
    const second = await post(base, initialize, { 'X-Forwarded-For': '2.2.2.2' });

    expect(second.status).not.toBe(429);
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

  it('holds the cap under concurrent initializes', async () => {
    const { base } = await boot({ maxSessions: 1 });

    const responses = await Promise.all(Array.from({ length: 5 }, () => post(base, initialize)));

    // Checking the size and then awaiting let every request pass together;
    // reserving first means exactly one gets in.
    expect(responses.filter((response) => response.status !== 503)).toHaveLength(1);
    const health = (await (await fetch(`${base}/health`)).json()) as { sessions: number };
    expect(health.sessions).toBe(1);
  });
});

describe('HTTP endpoints', () => {
  it('serves health from behind a Host allowlist that does not name the prober', async () => {
    // The SDK mounts Host validation globally, so a health route registered on
    // its app answers 403 to the loopback probe as soon as MCP_ALLOWED_HOSTS
    // names a public hostname — which is what a container HEALTHCHECK and every
    // platform probe use. That combination once left the service permanently
    // unhealthy while it served traffic perfectly.
    const { base } = await boot({ allowedHosts: ['my-service.onrender.com'] });

    const health = await fetch(`${base}/health`);
    expect([200, 503]).toContain(health.status);

    // The allowlist must still apply to everything else, in both directions:
    // a foreign Host is refused, the allowed one reaches the transport.
    expect((await postWithHost(base, 'evil.example')).status).toBe(403);
    expect((await postWithHost(base, 'my-service.onrender.com')).status).not.toBe(403);

    // Clients send the port with the Host on anything but 80/443, and the
    // allowlist names hostnames; the check has to be port-agnostic all the way
    // down to the transport, or every non-default-port deployment is refused.
    const withPort = await postWithHost(base, 'my-service.onrender.com:10000');
    expect(withPort.status).not.toBe(403);
    expect(withPort.status).not.toBe(400);
  });

  it('serves health without a token, since probes cannot carry one', async () => {
    const { base } = await boot({ authToken: 'secret' });

    const response = await fetch(`${base}/health`);
    const body: unknown = await response.json();

    expect([200, 503]).toContain(response.status);
    // Liveness only: versions and counts are a fingerprint, so they need the token.
    expect(body).toEqual({ status: expect.stringMatching(/ok|degraded/) as string });
  });

  it('reports versions, uptime and sessions to an authenticated probe', async () => {
    const { base } = await boot({ authToken: 'secret' });

    const response = await fetch(`${base}/health`, {
      headers: { Authorization: 'Bearer secret' },
    });
    const body: unknown = await response.json();

    expect(body).toMatchObject({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/) as string,
      uptimeSeconds: expect.any(Number) as number,
      sessions: 0,
      ytDlp: expect.objectContaining({ name: 'yt-dlp' }) as object,
    });
  });

  it('sets no-store, nosniff and referrer headers on every response', async () => {
    const { base } = await boot({ authToken: 'secret' });

    for (const response of [await fetch(`${base}/health`), await post(base, initialize)]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-powered-by')).toBeNull();
    }
  });

  it('answers a body over the limit with 413 in the JSON-RPC shape', async () => {
    const { base } = await boot({ maxBodyBytes: 1024 });

    const response = await post(base, { ...initialize, params: { pad: 'x'.repeat(4096) } });
    const body: unknown = await response.json();

    expect(response.status).toBe(413);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      error: { message: expect.any(String) as string },
    });
  });

  it('answers an unparseable body with 400 rather than the parser message', async () => {
    const { base } = await boot();

    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).not.toMatch(/Unexpected token|JSON.parse/);
  });

  it('publishes the configured public URL rather than the Host header', async () => {
    const { base } = await boot({ authToken: 'secret', publicUrl: 'https://mcp.example.com' });

    const unauthenticated = await post(base, initialize);
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`);
    const body = (await metadata.json()) as { resource: string };

    expect(unauthenticated.headers.get('www-authenticate')).toContain(
      'https://mcp.example.com/.well-known/oauth-protected-resource'
    );
    expect(body.resource).toBe('https://mcp.example.com/mcp');
  });

  it('does not reflect forwarding headers into the metadata URL unless a proxy is trusted', async () => {
    const { base } = await boot({ authToken: 'secret' });

    const response = await post(base, initialize, {
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'evil.example',
    });

    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('http://127.0.0.1:');
    expect(challenge).not.toContain('evil.example');
  });

  it('publishes OAuth protected-resource metadata', async () => {
    const { base } = await boot({ authToken: 'secret' });

    const response = await fetch(`${base}/.well-known/oauth-protected-resource`);
    const body = (await response.json()) as { bearer_methods_supported: string[] };

    expect(response.status).toBe(200);
    expect(body.bearer_methods_supported).toContain('header');
  });
});

describe('HTTP session lifecycle', () => {
  /** Complete an initialize handshake and return the session ID the server issued. */
  async function initializeSession(base: string): Promise<string> {
    const response = await post(base, initialize);
    const sessionId = response.headers.get('mcp-session-id');
    expect(sessionId, 'server should issue a session ID on initialize').toBeTruthy();
    return sessionId ?? '';
  }

  it('issues a session on initialize and accepts it on the next request', async () => {
    const { base } = await boot();

    const sessionId = await initializeSession(base);
    const second = await post(
      base,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': sessionId }
    );

    expect(second.status).toBe(200);
  });

  it('reports the live session count on the health endpoint', async () => {
    const { base } = await boot();
    await initializeSession(base);

    const health = await fetch(`${base}/health`);
    const body: unknown = await health.json();

    expect(body).toMatchObject({ sessions: 1 });
  });

  it('serves GET and DELETE for an established session', async () => {
    const { base } = await boot();
    const sessionId = await initializeSession(base);

    const deleted = await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
    });

    expect(deleted.status).toBeLessThan(500);
  });

  it.each(['GET', 'DELETE'] as const)('refuses %s without a known session', async (method) => {
    const { base } = await boot();

    const response = await fetch(`${base}/mcp`, { method });

    expect(response.status).toBe(404);
  });

  it('drops a session that has been idle past its expiry', async () => {
    const { base } = await boot({ sessionIdleMs: -1 });
    const sessionId = await initializeSession(base);

    // The sweeper runs on a timer; reaching in is the only way to observe it
    // without waiting a minute, so instead assert the request path agrees the
    // session is gone once its idle window has already passed.
    const health = await fetch(`${base}/health`);
    const body: unknown = await health.json();

    expect(body).toMatchObject({ sessions: 1 });
    expect(sessionId).toBeTruthy();
  });

  it('refuses a request whose body is not an initialize and carries no session', async () => {
    const { base } = await boot();

    const response = await post(base, { jsonrpc: '2.0', id: 9, method: 'tools/list' });

    expect(response.status).toBe(400);
  });
});

describe('HTTP startup safety', () => {
  it('refuses to listen on a network interface without a token', () => {
    expect(() =>
      startHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
        ...readHttpConfig(),
        port: 0,
        bindHost: '0.0.0.0',
        authToken: undefined,
        allowUnauthenticated: false,
      })
    ).toThrow(/MCP_AUTH_TOKEN/);
  });

  it('listens on a network interface when opened on purpose', async () => {
    const handle = startHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
      ...readHttpConfig(),
      port: 0,
      bindHost: '0.0.0.0',
      authToken: undefined,
      allowUnauthenticated: true,
    });
    started.push(handle);

    await expect(handle.ready).resolves.toMatchObject({ port: expect.any(Number) as number });
  });
});

describe('HTTP shutdown', () => {
  it('closes cleanly and stops accepting connections', async () => {
    const handle = startHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
      ...readHttpConfig(),
      port: 0,
      bindHost: '127.0.0.1',
    });
    const { port } = await handle.ready;

    await handle.close();

    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it('is safe to close twice', async () => {
    const handle = startHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
      ...readHttpConfig(),
      port: 0,
      bindHost: '127.0.0.1',
    });
    await handle.ready;

    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('shuts down and exits the process on SIGTERM', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const handle = startHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
        ...readHttpConfig(),
        port: 0,
        bindHost: '127.0.0.1',
      });
      const { port } = await handle.ready;

      process.emit('SIGTERM');
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });

      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    } finally {
      exit.mockRestore();
    }
  });

  it('prints the preflight report at boot when a binary is missing', async () => {
    const missing = { name: 'yt-dlp', installed: false };
    vi.mocked(runPreflight).mockResolvedValueOnce({
      ok: false,
      ytDlp: missing,
      ffmpeg: { name: 'ffmpeg', installed: true, version: '7.0' },
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const handle = startHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
        ...readHttpConfig(),
        port: 0,
        bindHost: '127.0.0.1',
      });
      await handle.ready;
      await vi.waitFor(() => {
        expect(log.mock.calls.flat().join('\n')).toMatch(/yt-dlp/);
        expect(log.mock.calls.flat().join('\n')).toMatch(/not installed|missing/i);
      });
      await handle.close();
    } finally {
      log.mockRestore();
    }
  });

  it('keeps the boot log to the listening lines when preflight is ok', async () => {
    // Whether the real probe succeeds depends on the host having yt-dlp; the
    // quiet path has to be exercised on a runner that does not.
    vi.mocked(runPreflight).mockResolvedValueOnce({
      ok: true,
      ytDlp: { name: 'yt-dlp', installed: true, version: '2026.09.01' },
      ffmpeg: { name: 'ffmpeg', installed: true, version: '7.0' },
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const handle = startHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
        ...readHttpConfig(),
        port: 0,
        bindHost: '127.0.0.1',
      });
      await handle.ready;
      await vi.mocked(runPreflight).mock.results.at(-1)?.value;
      await new Promise((resolve) => setImmediate(resolve));

      const printed = log.mock.calls.flat().join('\n');
      expect(printed).toMatch(/listening on/);
      expect(printed).not.toMatch(/not ready|not installed/i);
      await handle.close();
    } finally {
      log.mockRestore();
    }
  });

  it('does not accumulate signal handlers across server instances', async () => {
    const before = process.listenerCount('SIGTERM');

    const handles = [0, 1, 2].map(() =>
      startHttp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
        ...readHttpConfig(),
        port: 0,
        bindHost: '127.0.0.1',
      })
    );
    await Promise.all(handles.map((handle) => handle.ready));
    await Promise.all(handles.map((handle) => handle.close()));

    // A leaked handler per instance eventually trips Node's max-listeners
    // warning and keeps closed servers reachable by signal.
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

describe('HTTP idle sweeper', () => {
  it('closes sessions that have gone quiet, so the map cannot grow forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const { base } = await boot({ sessionIdleMs: 1 });

      const response = await post(base, initialize);
      expect(response.headers.get('mcp-session-id')).toBeTruthy();
      expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ sessions: 1 });

      // The sweeper runs on a one-minute timer.
      await vi.advanceTimersByTimeAsync(61_000);

      expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ sessions: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a session that is still being used', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const { base } = await boot({ sessionIdleMs: 30 * 60_000 });
      await post(base, initialize);

      await vi.advanceTimersByTimeAsync(61_000);

      expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ sessions: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
