import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildApp } from './http/app.js';
import { readHttpConfig, type HttpConfig } from './http/config.js';
import { RateLimiter } from './http/rate-limiter.js';
import { SessionStore } from './http/sessions.js';
import { formatPreflightReport, runPreflight } from './utils/preflight.js';

/**
 * Streamable HTTP transport.
 *
 * Split out of index.ts because it carries all of the deployment-facing
 * concerns — authentication, origin validation, session lifetime, rate limits —
 * none of which apply to the stdio path. The pieces live under `src/http/`;
 * this module wires them together and owns the process-level lifecycle.
 */

export { bearerToken, clientKey, sessionIdOf, tokenMatches } from './http/auth.js';
export { readHttpConfig, type HttpConfig } from './http/config.js';
export { RateLimiter } from './http/rate-limiter.js';

export interface HttpServerHandle {
  close: () => Promise<void>;
  /** Resolves once bound. Port 0 picks a free port, which tests rely on. */
  ready: Promise<{ port: number }>;
}

export function startHttp(
  createServer: (mode: 'http') => McpServer,
  config: HttpConfig = readHttpConfig()
): HttpServerHandle {
  const limiter = new RateLimiter(config.rateLimit, config.rateWindowMs);
  const sessions = new SessionStore();
  const app = buildApp(config, createServer, sessions, limiter);

  // Both timers are unref'd: they must never be the reason the process stays up.
  const sweeper = setInterval(() => {
    const now = Date.now();
    limiter.sweep(now);
    sessions.sweep(now, config.sessionIdleMs);
  }, 60_000);
  sweeper.unref();

  // A promise executor runs synchronously, so the resolver is assigned before
  // anything can call it; the assertion states that rather than a dummy default.
  let announceReady!: (value: { port: number }) => void;
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
    await sessions.closeAll();
    await new Promise<void>((resolve) =>
      httpServer.close(() => {
        resolve();
      })
    );
  };

  for (const signal of signals) process.once(signal, onSignal);

  return { close, ready };
}
