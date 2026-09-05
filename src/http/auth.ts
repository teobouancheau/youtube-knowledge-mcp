import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

/** Bearer tokens, session ids and the JSON-RPC error envelope. */

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
