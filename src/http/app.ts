import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runPreflight } from '../utils/preflight.js';
import { serverVersion } from '../utils/version.js';
import {
  bearerToken,
  clientKey,
  jsonRpcError,
  publicBaseUrl,
  securityHeaders,
  sessionIdOf,
  tokenMatches,
} from './auth.js';
import { isLoopback, type HttpConfig } from './config.js';
import type { RateLimiter } from './rate-limiter.js';
import type { SessionStore } from './sessions.js';

/** The Express application: routes, authentication and rate limiting. */

export interface AppDependencies {
  createServer: (mode: 'http') => McpServer;
  sessions: SessionStore;
  limiter: RateLimiter;
  /** The bound port, known only once listening; read lazily for that reason. */
  port: () => number;
  startedAt: number;
}

export function buildApp(config: HttpConfig, deps: AppDependencies): Express {
  const { createServer, sessions, limiter, port, startedAt } = deps;
  const app: Express = express();

  // `req.ip` honours forwarded headers only when the operator names the proxies.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(securityHeaders());

  // Every route, before anything else: an unauthenticated flood is still a flood.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const { allowed, remaining, retryAfter } = limiter.check(clientKey(req));
    res.setHeader('RateLimit-Limit', String(config.rateLimit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    if (allowed) {
      next();
      return;
    }
    // Without Retry-After a client has no idea how long to wait.
    res.setHeader('Retry-After', String(retryAfter));
    jsonRpcError(res, 429, -32000, `Rate limit exceeded. Retry in ${retryAfter}s.`);
  });

  function hasValidToken(req: Request): boolean {
    return (
      config.authToken === undefined ||
      tokenMatches(bearerToken(req.headers.authorization), config.authToken)
    );
  }

  /** Returns true when the request may proceed; otherwise it has been answered. */
  function authorize(req: Request, res: Response): boolean {
    if (hasValidToken(req)) return true;
    // RFC 9728: point unauthenticated callers at the resource metadata.
    const metadata = `${publicBaseUrl(config, req, port())}/.well-known/oauth-protected-resource`;
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="youtube-knowledge-mcp", resource_metadata="${metadata}"`
    );
    jsonRpcError(res, 401, -32001, 'Unauthorized');
    return false;
  }

  // Ahead of Host validation on purpose: a container's own HEALTHCHECK and every
  // platform probe arrive over loopback with a Host the allowlist may not name,
  // and a service that 403s its probe never goes live. Unauthenticated callers
  // learn only whether the service is up; versions and counts need the token.
  app.get('/health', (req: Request, res: Response) => {
    void runPreflight().then((report) => {
      const status = report.ok ? 'ok' : 'degraded';
      const body = hasValidToken(req)
        ? {
            status,
            version: serverVersion(),
            uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
            ytDlp: report.ytDlp,
            ffmpeg: report.ffmpeg,
            sessions: sessions.size,
          }
        : { status };
      res.writeHead(report.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });

  app.use(express.json({ limit: config.maxBodyBytes }));
  app.use(bodyErrorHandler);

  // The same decision the SDK's createMcpExpressApp makes, made explicitly so a
  // body limit could be configured: an allowlist when one is given, loopback
  // validation when bound to loopback, nothing when bound wide (a token is
  // then required by assertSafeToStart).
  if (config.allowedHosts.length > 0) app.use(hostHeaderValidation(config.allowedHosts));
  else if (isLoopback(config.bindHost)) app.use(localhostHostValidation());

  app.post('/mcp', async (req: Request, res: Response) => {
    if (!authorize(req, res)) return;

    const sessionId = sessionIdOf(req);

    try {
      const existing = sessionId === undefined ? undefined : sessions.get(sessionId);
      if (existing !== undefined && sessionId !== undefined) {
        sessions.touch(sessionId);
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        await openSession(req, res);
        return;
      }

      jsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
    } catch (error: unknown) {
      console.error('Error handling MCP request:', error);
      jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });

  async function openSession(req: Request, res: Response): Promise<void> {
    // Reserved before the first await, so concurrent initializes cannot all
    // pass a size check and overshoot the cap together.
    if (!sessions.reserve()) {
      jsonRpcError(res, 503, -32000, 'Server is at capacity. Try again shortly.');
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Hosts are checked by the port-agnostic middleware above on every
      // route; the transport's own check would compare the whole Host header,
      // port included, and reject every deployment on a non-default port.
      ...(config.allowedOrigins.length > 0
        ? { enableDnsRebindingProtection: true, allowedOrigins: config.allowedOrigins }
        : {}),
      onsessioninitialized: (id: string) => {
        sessions.commit(id, transport);
      },
    });

    transport.onclose = (): void => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    try {
      await createServer('http').connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      // The transport carries an id only once the session was initialised, so
      // its absence means the reservation was never turned into a session.
      if (transport.sessionId === undefined) sessions.release();
    }
  }

  const bySession = async (req: Request, res: Response): Promise<void> => {
    if (!authorize(req, res)) return;

    const sessionId = sessionIdOf(req);
    const session = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (sessionId === undefined || session === undefined) {
      jsonRpcError(res, 404, -32001, 'Invalid or missing session ID');
      return;
    }
    sessions.touch(sessionId);
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
        resource: `${publicBaseUrl(config, req, port())}/mcp`,
        bearer_methods_supported: ['header'],
        resource_documentation: 'https://github.com/teobouancheau/youtube-knowledge-mcp#readme',
      })
    );
  });

  return app;
}

/**
 * Body-parser failures arrive as errors with an HTTP status; Express 5 routes
 * them to the first four-argument middleware. Answered in the JSON-RPC shape
 * every other refusal uses, and never with the parser's own message.
 */
function bodyErrorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number(error.status)
      : Number.NaN;

  if (status === 413) {
    jsonRpcError(res, 413, -32600, 'Request body too large.');
    return;
  }
  if (status >= 400 && status < 500) {
    jsonRpcError(res, status, -32700, 'Request body could not be parsed.');
    return;
  }
  next(error);
}
