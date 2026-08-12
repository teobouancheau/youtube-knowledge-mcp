import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatPreflightReport, runPreflight } from './utils/preflight.js';

/**
 * Streamable HTTP transport.
 *
 * Split out of index.ts because it carries all of the deployment-facing
 * concerns — authentication, origin validation, session lifetime, rate limits —
 * none of which apply to the stdio path.
 */

export interface HttpConfig {
  port: number;
  /** Interface to bind. Containers need 0.0.0.0; local runs should use 127.0.0.1. */
  bindHost: string;
  /** When set, every request must present this as a bearer token. */
  authToken?: string;
  /** Host header allowlist. Empty means "accept any", which is only safe behind a proxy. */
  allowedHosts: string[];
  /** Origin header allowlist for browser callers. */
  allowedOrigins: string[];
  rateLimit: number;
  rateWindowMs: number;
  /** Sessions idle longer than this are closed, so the map cannot grow forever. */
  sessionIdleMs: number;
  maxSessions: number;
}

function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readHttpConfig(): HttpConfig {
  return {
    port: envInt('PORT', 3000),
    bindHost: process.env.MCP_BIND_HOST ?? '0.0.0.0',
    // An empty MCP_AUTH_TOKEN must mean "no auth", not "the empty token".
    authToken: process.env.MCP_AUTH_TOKEN?.trim() === '' ? undefined : process.env.MCP_AUTH_TOKEN,
    allowedHosts: envList('MCP_ALLOWED_HOSTS'),
    allowedOrigins: envList('MCP_ALLOWED_ORIGINS'),
    rateLimit: envInt('MCP_RATE_LIMIT', 60),
    rateWindowMs: envInt('MCP_RATE_WINDOW_MS', 60_000),
    sessionIdleMs: envInt('MCP_SESSION_IDLE_MS', 30 * 60_000),
    maxSessions: envInt('MCP_MAX_SESSIONS', 1000),
  };
}

/** Fixed-window counter, per client. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  check(
    key: string,
    now = Date.now()
  ): { allowed: boolean; remaining: number; retryAfter: number } {
    const entry = this.hits.get(key);

    if (!entry || now > entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfter: 0 };
    }

    entry.count++;
    const allowed = entry.count <= this.limit;
    return {
      allowed,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfter: allowed ? 0 : Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  sweep(now = Date.now()): void {
    for (const [key, entry] of this.hits) {
      if (now > entry.resetAt) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

/**
 * Compare a presented token against the configured one in constant time, so the
 * endpoint does not leak the token's prefix through response timing.
 */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which would itself be a leak;
  // hash-free equalisation keeps the comparison constant-time for equal lengths
  // and constant-result for unequal ones.
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export function clientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export interface HttpServerHandle {
  close: () => Promise<void>;
  /** Resolves once bound. Port 0 picks a free port, which tests rely on. */
  ready: Promise<{ port: number }>;
}

export function startHttp(
  createServer: (mode: 'http') => McpServer,
  config: HttpConfig = readHttpConfig()
): HttpServerHandle {
  const app: Express = createMcpExpressApp({
    host: config.bindHost,
    ...(config.allowedHosts.length > 0 ? { allowedHosts: config.allowedHosts } : {}),
  });

  const limiter = new RateLimiter(config.rateLimit, config.rateWindowMs);
  const sessions = new Map<string, Session>();

  // Both timers are unref'd: they must never be the reason the process stays up.
  const sweeper = setInterval(() => {
    const now = Date.now();
    limiter.sweep(now);
    for (const [id, session] of sessions) {
      if (now - session.lastSeen > config.sessionIdleMs) {
        sessions.delete(id);
        void session.transport.close();
      }
    }
  }, 60_000);
  sweeper.unref();

  /** Returns true when the request may proceed; otherwise it has been answered. */
  function authorize(req: Request, res: Response): boolean {
    if (!config.authToken) return true;

    if (!tokenMatches(bearerToken(req.headers.authorization), config.authToken)) {
      // RFC 9728: point unauthenticated callers at the resource metadata.
      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="youtube-knowledge-mcp", resource_metadata="${resourceMetadataUrl(req)}"`
      );
      jsonRpcError(res, 401, -32001, 'Unauthorized');
      return false;
    }
    return true;
  }

  function rateLimit(req: Request, res: Response): boolean {
    const { allowed, remaining, retryAfter } = limiter.check(clientKey(req));
    res.setHeader('RateLimit-Limit', String(config.rateLimit));
    res.setHeader('RateLimit-Remaining', String(remaining));

    if (!allowed) {
      // Without Retry-After a client has no idea how long to wait.
      res.setHeader('Retry-After', String(retryAfter));
      jsonRpcError(res, 429, -32000, `Rate limit exceeded. Retry in ${retryAfter}s.`);
      return false;
    }
    return true;
  }

  function resourceMetadataUrl(req: Request): string {
    const host = req.headers.host ?? `localhost:${config.port}`;
    const proto = req.headers['x-forwarded-proto'] ?? 'https';
    return `${String(proto)}://${host}/.well-known/oauth-protected-resource`;
  }

  app.post('/mcp', async (req: Request, res: Response) => {
    if (!rateLimit(req, res)) return;
    if (!authorize(req, res)) return;

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        existing.lastSeen = Date.now();
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        if (sessions.size >= config.maxSessions) {
          jsonRpcError(res, 503, -32000, 'Server is at capacity. Try again shortly.');
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          ...(config.allowedHosts.length > 0 || config.allowedOrigins.length > 0
            ? {
                enableDnsRebindingProtection: true,
                allowedHosts: config.allowedHosts,
                allowedOrigins: config.allowedOrigins,
              }
            : {}),
          onsessioninitialized: (id: string) => {
            sessions.set(id, { transport, lastSeen: Date.now() });
          },
        });

        transport.onclose = (): void => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };

        await createServer('http').connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      jsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
    } catch (error: unknown) {
      console.error('Error handling MCP request:', error);
      jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });

  const bySession = async (req: Request, res: Response): Promise<void> => {
    if (!authorize(req, res)) return;

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      jsonRpcError(res, 404, -32001, 'Invalid or missing session ID');
      return;
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res);
  };

  app.get('/mcp', bySession);
  app.delete('/mcp', bySession);

  // RFC 9728 protected-resource metadata, so OAuth-capable clients can discover
  // how to authenticate instead of guessing.
  app.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        resource: `${String(req.headers['x-forwarded-proto'] ?? 'https')}://${req.headers.host ?? ''}/mcp`,
        bearer_methods_supported: ['header'],
        resource_documentation: 'https://github.com/teobouancheau/youtube-knowledge-mcp#readme',
      })
    );
  });

  // Unauthenticated on purpose: platform health probes cannot carry a token.
  app.get('/health', (_req: Request, res: Response) => {
    void runPreflight().then((report) => {
      res.writeHead(report.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: report.ok ? 'ok' : 'degraded',
          ytDlp: report.ytDlp,
          ffmpeg: report.ffmpeg,
          sessions: sessions.size,
        })
      );
    });
  });

  let announceReady: (value: { port: number }) => void = () => undefined;
  const ready = new Promise<{ port: number }>((resolve) => {
    announceReady = resolve;
  });

  const httpServer = app.listen(config.port, () => {
    const address = httpServer.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;
    announceReady({ port });

    console.error(`MCP Streamable HTTP server listening on ${config.bindHost}:${port}`);
    console.error(`MCP endpoint: http://localhost:${port}/mcp`);
    console.error(
      config.authToken
        ? 'Authentication: bearer token required'
        : 'Authentication: DISABLED — set MCP_AUTH_TOKEN to require a bearer token'
    );
    if (config.allowedHosts.length === 0 && config.allowedOrigins.length === 0) {
      console.error(
        'DNS rebinding protection: DISABLED — set MCP_ALLOWED_HOSTS and/or MCP_ALLOWED_ORIGINS to enable'
      );
    }
    void runPreflight().then((report) => {
      if (!report.ok) console.error(formatPreflightReport(report));
    });
  });

  // SIGTERM is what container platforms actually send; only SIGINT was handled.
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const onSignal = (): void => {
    void close().then(() => process.exit(0));
  };

  const close = async (): Promise<void> => {
    // Detach first: a handle that has been closed must not keep the process
    // alive through a listener, and repeated boots must not accumulate them.
    for (const signal of signals) process.off(signal, onSignal);

    clearInterval(sweeper);
    for (const [id, session] of sessions) {
      sessions.delete(id);
      await session.transport.close();
    }
    await new Promise<void>((resolve) =>
      httpServer.close(() => {
        resolve();
      })
    );
  };

  for (const signal of signals) process.once(signal, onSignal);

  return { close, ready };
}
