/** Deployment configuration for the Streamable HTTP transport, read from the environment. */

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
