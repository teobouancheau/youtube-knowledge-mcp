import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { HttpConfig } from './config.js';

/** Bearer tokens, client identity, session ids and the JSON-RPC error envelope. */

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

/**
 * The key a client is rate-limited under.
 *
 * `req.ip` is what Express derives after applying the `trust proxy` setting:
 * the socket address by default, and the forwarded client only when the
 * operator has said which proxies to believe. Reading `X-Forwarded-For`
 * directly, as this once did, let any caller mint a fresh quota per request.
 */
export function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Node parses a repeated header into an array, so this field is genuinely
 * `string | string[] | undefined`. Asserting it was always a string meant a
 * request that sent `Mcp-Session-Id` twice reached `sessions.get()` holding an
 * array, missed every session, and was reported as an invalid session ID.
 * Ambiguous is treated as absent: two session IDs identify no session.
 */
export function sessionIdOf(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return typeof header === 'string' ? header : undefined;
}

export function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * The base URL this server publishes in OAuth metadata.
 *
 * Configuration first; the request's own view of itself only when a proxy is
 * trusted to have set it. Reflecting `Host` unconditionally let anyone who
 * could reach the endpoint choose the address other clients were told to use.
 */
export function publicBaseUrl(config: HttpConfig, req: Request, port: number): string {
  if (config.publicUrl !== undefined) return config.publicUrl;
  if (config.trustProxy !== false) return `${req.protocol}://${req.get('host') ?? ''}`;
  return `http://${config.bindHost}:${port}`;
}

/** Headers every response carries; none of them cost anything for an API. */
export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  };
}
