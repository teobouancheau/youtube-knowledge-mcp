import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request } from 'express';
import {
  RateLimiter,
  assertSafeToStart,
  bearerToken,
  clientKey,
  readHttpConfig,
  sessionIdOf,
  tokenMatches,
} from '../src/http.js';

describe('RateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('a', 0).allowed).toBe(true);
  });

  it('blocks the request past the limit', () => {
    const limiter = new RateLimiter(2, 60_000);
    limiter.check('a', 0);
    limiter.check('a', 0);
    expect(limiter.check('a', 0).allowed).toBe(false);
  });

  it('tells a blocked client how long to wait', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.check('a', 0);

    // Without Retry-After the client can only guess.
    expect(limiter.check('a', 10_000).retryAfter).toBe(50);
  });

  it('reports remaining quota', () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.check('a', 0).remaining).toBe(2);
    expect(limiter.check('a', 0).remaining).toBe(1);
  });

  it('counts each client separately', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.check('a', 0);
    expect(limiter.check('b', 0).allowed).toBe(true);
  });

  it('starts a fresh window once the old one expires', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.check('a', 0);
    expect(limiter.check('a', 60_001).allowed).toBe(true);
  });

  it('sweeps expired entries so the map cannot grow without bound', () => {
    const limiter = new RateLimiter(10, 60_000);
    limiter.check('a', 0);
    limiter.check('b', 0);
    expect(limiter.size).toBe(2);

    limiter.sweep(60_001);
    expect(limiter.size).toBe(0);
  });

  it('keeps live entries when sweeping', () => {
    const limiter = new RateLimiter(10, 60_000);
    limiter.check('a', 0);
    limiter.sweep(30_000);
    expect(limiter.size).toBe(1);
  });
});

describe('bearerToken', () => {
  it.each([
    ['Bearer abc123', 'abc123'],
    ['bearer abc123', 'abc123'],
    ['Bearer   abc123', 'abc123'],
    ['  Bearer abc123  ', 'abc123'],
  ])('extracts the token from %s', (header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });

  it.each([undefined, '', 'abc123', 'Basic abc123', 'Bearer'])('rejects %s', (header) => {
    expect(bearerToken(header)).toBeUndefined();
  });
});

describe('tokenMatches', () => {
  it('accepts the configured token', () => {
    expect(tokenMatches('secret', 'secret')).toBe(true);
  });

  it.each([
    ['a wrong token of equal length', 'secreX'],
    ['a prefix of the token', 'secre'],
    ['a superset of the token', 'secretx'],
    ['an empty token', ''],
  ])('rejects %s', (_label, presented) => {
    expect(tokenMatches(presented, 'secret')).toBe(false);
  });

  it('rejects a missing token', () => {
    expect(tokenMatches(undefined, 'secret')).toBe(false);
  });
});

describe('sessionIdOf', () => {
  const request = (headers: Record<string, unknown>): Request =>
    ({ headers, socket: {} }) as unknown as Request;

  it('reads the session ID', () => {
    expect(sessionIdOf(request({ 'mcp-session-id': 'abc' }))).toBe('abc');
  });

  it('treats a repeated header as no session rather than as one', () => {
    // Node parses a repeated header into an array. Asserting it was a string
    // sent the array on to sessions.get(), which matched nothing and reported
    // an invalid session ID for what is really an ambiguous request.
    expect(sessionIdOf(request({ 'mcp-session-id': ['abc', 'def'] }))).toBeUndefined();
  });

  it('reports no session when the header is absent', () => {
    expect(sessionIdOf(request({}))).toBeUndefined();
  });
});

describe('clientKey', () => {
  const request = (ip: string | undefined, remoteAddress?: string, headers = {}): Request =>
    ({ ip, headers, socket: { remoteAddress } }) as unknown as Request;

  it('uses the address Express derived, which honours trust proxy', () => {
    expect(clientKey(request('1.2.3.4', '9.9.9.9'))).toBe('1.2.3.4');
  });

  // The header used to be read directly, so any caller could mint a fresh
  // quota per request by varying it.
  it('never reads x-forwarded-for itself', () => {
    expect(clientKey(request('9.9.9.9', '9.9.9.9', { 'x-forwarded-for': '1.2.3.4' }))).toBe(
      '9.9.9.9'
    );
  });

  it('falls back to the socket address', () => {
    expect(clientKey(request(undefined, '9.9.9.9'))).toBe('9.9.9.9');
  });

  it('falls back to a constant when nothing identifies the client', () => {
    expect(clientKey(request(undefined))).toBe('unknown');
  });
});

describe('RateLimiter key cap', () => {
  it('evicts the oldest client rather than growing past maxKeys', () => {
    const limiter = new RateLimiter(10, 60_000, 2);
    limiter.check('a', 0);
    limiter.check('b', 0);
    limiter.check('c', 0);

    expect(limiter.size).toBe(2);
    // 'a' was evicted, so it starts a fresh window rather than continuing one.
    expect(limiter.check('a', 0).remaining).toBe(9);
  });

  it('prefers evicting expired entries', () => {
    const limiter = new RateLimiter(10, 1_000, 2);
    limiter.check('a', 0);
    limiter.check('b', 5_000);
    limiter.check('c', 5_000);

    expect(limiter.check('b', 5_000).remaining).toBe(8);
  });
});

describe('readHttpConfig', () => {
  const saved = { ...process.env };
  // Rejected values are reported on stderr; the assertions below are about
  // the values, so the report is silenced rather than asserted here.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  beforeEach(() => {
    // Rebuild the environment without the keys under test, rather than deleting
    // computed keys in place.
    const stripped = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MCP_') && key !== 'PORT')
    );
    process.env = stripped;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to no auth, so an existing deployment keeps working', () => {
    expect(readHttpConfig().authToken).toBeUndefined();
  });

  it('binds loopback by default', () => {
    expect(readHttpConfig().bindHost).toBe('127.0.0.1');
  });

  it('does not trust proxies by default', () => {
    expect(readHttpConfig().trustProxy).toBe(false);
  });

  it.each([
    ['true', true],
    ['false', false],
    ['1', 1],
    ['2', 2],
  ])('reads MCP_TRUST_PROXY=%s as %j', (value, expected) => {
    process.env.MCP_TRUST_PROXY = value;
    expect(readHttpConfig().trustProxy).toBe(expected);
  });

  it('reads MCP_PUBLIC_URL without a trailing slash', () => {
    process.env.MCP_PUBLIC_URL = 'https://mcp.example.com/';
    expect(readHttpConfig().publicUrl).toBe('https://mcp.example.com');
  });

  it('ignores an MCP_PUBLIC_URL that is not an http(s) URL', () => {
    process.env.MCP_PUBLIC_URL = 'ftp://mcp.example.com';
    expect(readHttpConfig().publicUrl).toBeUndefined();
    process.env.MCP_PUBLIC_URL = 'nonsense';
    expect(readHttpConfig().publicUrl).toBeUndefined();
  });

  it('caps the request body at 1 MiB unless told otherwise, with a floor', () => {
    expect(readHttpConfig().maxBodyBytes).toBe(1024 * 1024);
    process.env.MCP_MAX_BODY_BYTES = '4096';
    expect(readHttpConfig().maxBodyBytes).toBe(4096);
    process.env.MCP_MAX_BODY_BYTES = '10';
    expect(readHttpConfig().maxBodyBytes).toBe(1024 * 1024);
  });

  it('requires explicit consent to run open on a network', () => {
    expect(readHttpConfig().allowUnauthenticated).toBe(false);
    process.env.MCP_ALLOW_UNAUTHENTICATED = 'true';
    expect(readHttpConfig().allowUnauthenticated).toBe(true);
  });

  it('treats an empty MCP_AUTH_TOKEN as no auth rather than the empty token', () => {
    process.env.MCP_AUTH_TOKEN = '   ';
    expect(readHttpConfig().authToken).toBeUndefined();
  });

  it('enables auth when a token is set', () => {
    process.env.MCP_AUTH_TOKEN = 'secret';
    expect(readHttpConfig().authToken).toBe('secret');
  });

  it('parses comma-separated allowlists and drops blanks', () => {
    process.env.MCP_ALLOWED_HOSTS = 'a.example.com, b.example.com ,';
    expect(readHttpConfig().allowedHosts).toEqual(['a.example.com', 'b.example.com']);
  });

  it('defaults the allowlists to empty', () => {
    const config = readHttpConfig();
    expect(config.allowedHosts).toEqual([]);
    expect(config.allowedOrigins).toEqual([]);
  });

  it.each([
    ['not-a-number', 3000],
    ['0', 3000],
    ['-1', 3000],
    ['8080', 8080],
  ])('reads PORT=%s as %d', (value, expected) => {
    process.env.PORT = value;
    expect(readHttpConfig().port).toBe(expected);
  });

  it('bounds sessions so the transport map cannot grow forever', () => {
    const config = readHttpConfig();
    expect(config.maxSessions).toBeGreaterThan(0);
    expect(config.sessionIdleMs).toBeGreaterThan(0);
  });
});

describe('assertSafeToStart', () => {
  const base = { ...readHttpConfig(), authToken: undefined, allowUnauthenticated: false };

  it.each(['127.0.0.1', 'localhost', '::1'])('allows an open server on %s', (bindHost) => {
    expect(() => {
      assertSafeToStart({ ...base, bindHost });
    }).not.toThrow();
  });

  it('refuses an open server on a network interface, naming both remedies', () => {
    expect(() => {
      assertSafeToStart({ ...base, bindHost: '0.0.0.0' });
    }).toThrow(/MCP_AUTH_TOKEN.*MCP_ALLOW_UNAUTHENTICATED/);
  });

  it('allows a network interface with a token', () => {
    expect(() => {
      assertSafeToStart({ ...base, bindHost: '0.0.0.0', authToken: 's' });
    }).not.toThrow();
  });

  it('allows a network interface when opened on purpose', () => {
    expect(() => {
      assertSafeToStart({ ...base, bindHost: '0.0.0.0', allowUnauthenticated: true });
    }).not.toThrow();
  });
});
