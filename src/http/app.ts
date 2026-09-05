import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runPreflight } from '../utils/preflight.js';
import { bearerToken, clientKey, jsonRpcError, sessionIdOf, tokenMatches } from './auth.js';
import type { HttpConfig } from './config.js';
import type { RateLimiter } from './rate-limiter.js';
import type { SessionStore } from './sessions.js';

/** The Express application: routes, authentication and rate limiting. */

export function buildApp(
  config: HttpConfig,
  createServer: (mode: 'http') => McpServer,
  sessions: SessionStore,
  limiter: RateLimiter
): Express {
  const mcpApp: Express = createMcpExpressApp({
    host: config.bindHost,
    ...(config.allowedHosts.length > 0 ? { allowedHosts: config.allowedHosts } : {}),
  });

  // The SDK installs Host validation as global middleware, so everything
  // mounted on its app is behind the allowlist — including the health check,
  // which a probe reaches over loopback with `Host: 127.0.0.1:<port>`. Setting
  // MCP_ALLOWED_HOSTS to a public hostname would then 403 the container's own
  // HEALTHCHECK and every platform probe, and the service would never go live.
  // The health route is therefore mounted here, ahead of that middleware, and
  // the MCP app handles everything else with its allowlist intact.
  const app: Express = express();

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

  mcpApp.post('/mcp', async (req: Request, res: Response) => {
    if (!rateLimit(req, res)) return;
    if (!authorize(req, res)) return;

    const sessionId = sessionIdOf(req);

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
            sessions.set(id, transport);
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

    const sessionId = sessionIdOf(req);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      jsonRpcError(res, 404, -32001, 'Invalid or missing session ID');
      return;
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res);
  };

  mcpApp.get('/mcp', bySession);
  mcpApp.delete('/mcp', bySession);

  // RFC 9728 protected-resource metadata, so OAuth-capable clients can discover
  // how to authenticate instead of guessing.
  mcpApp.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
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
  // Registered before the MCP app so it also sits ahead of that app's Host
  // validation; it exposes binary versions and a session count, nothing a Host
  // allowlist protects.
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

  // Everything else — /mcp and the resource metadata — is served by the SDK's
  // app, so its Host allowlist and JSON body parsing still apply in full.
  app.use(mcpApp);

  return app;
}
