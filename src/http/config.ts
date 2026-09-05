import { envBool, envInt, envList, envString } from '../utils/env.js';

/** Deployment configuration for the Streamable HTTP transport, read from the environment. */

export interface HttpConfig {
  port: number;
  /** Interface to bind. Loopback by default; containers set 0.0.0.0 explicitly. */
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
  /**
   * Whether `X-Forwarded-*` headers are believed: `false`, `true`, or the number
   * of proxy hops in front of the server. Off by default, because a client can
   * write those headers itself.
   */
  trustProxy: boolean | number;
  /** The URL clients reach this server at, for the OAuth metadata it publishes. */
  publicUrl?: string;
  /** Largest request body accepted, in bytes. */
  maxBodyBytes: number;
  /** Explicit consent to listen on a non-loopback interface without a token. */
  allowUnauthenticated: boolean;
}

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function readTrustProxy(): boolean | number {
  const raw = envString('MCP_TRUST_PROXY');
  if (raw === undefined) return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return envBool('MCP_TRUST_PROXY', false);
}

function readPublicUrl(): string | undefined {
  const raw = envString('MCP_PUBLIC_URL');
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
    return url.toString().replace(/\/+$/, '');
  } catch {
    console.error('Ignoring MCP_PUBLIC_URL: not an http(s) URL.');
    return undefined;
  }
}

export function readHttpConfig(): HttpConfig {
  const publicUrl = readPublicUrl();
  return {
    port: envInt('PORT', 3000, { min: 1, max: 65_535 }),
    bindHost: envString('MCP_BIND_HOST') ?? '127.0.0.1',
    // An empty MCP_AUTH_TOKEN must mean "no auth", not "the empty token".
    authToken: envString('MCP_AUTH_TOKEN'),
    allowedHosts: envList('MCP_ALLOWED_HOSTS'),
    allowedOrigins: envList('MCP_ALLOWED_ORIGINS'),
    rateLimit: envInt('MCP_RATE_LIMIT', 60, { min: 1 }),
    rateWindowMs: envInt('MCP_RATE_WINDOW_MS', 60_000, { min: 1 }),
    sessionIdleMs: envInt('MCP_SESSION_IDLE_MS', 30 * 60_000, { min: 1 }),
    maxSessions: envInt('MCP_MAX_SESSIONS', 1000, { min: 1 }),
    trustProxy: readTrustProxy(),
    ...(publicUrl === undefined ? {} : { publicUrl }),
    maxBodyBytes: envInt('MCP_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, { min: 1024 }),
    allowUnauthenticated: envBool('MCP_ALLOW_UNAUTHENTICATED', false),
  };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Refuse to expose an unauthenticated server to a network.
 *
 * Binding beyond loopback with no token used to be the default and was merely
 * logged. Now it is a startup error unless the operator has said, in so many
 * words, that they mean it.
 */
export function assertSafeToStart(config: HttpConfig): void {
  if (
    isLoopback(config.bindHost) ||
    config.authToken !== undefined ||
    config.allowUnauthenticated
  ) {
    return;
  }
  throw new Error(
    `Refusing to listen on ${config.bindHost} without authentication. ` +
      'Set MCP_AUTH_TOKEN, or set MCP_ALLOW_UNAUTHENTICATED=true to run open on purpose.'
  );
}
