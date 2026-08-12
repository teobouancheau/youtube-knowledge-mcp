import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { RateLimiter, bearerToken, clientKey, readHttpConfig, tokenMatches } from '../src/http.js';

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

describe('clientKey', () => {
  const request = (headers: Record<string, unknown>, remoteAddress?: string): Request =>
    ({ headers, socket: { remoteAddress } }) as unknown as Request;

  it('prefers the first hop of x-forwarded-for', () => {
    expect(clientKey(request({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4');
  });

  it('handles a repeated x-forwarded-for header', () => {
    expect(clientKey(request({ 'x-forwarded-for': ['1.2.3.4', '5.6.7.8'] }))).toBe('1.2.3.4');
  });

  it('falls back to the socket address', () => {
    expect(clientKey(request({}, '9.9.9.9'))).toBe('9.9.9.9');
  });

  it('falls back to a constant when nothing identifies the client', () => {
    expect(clientKey(request({}))).toBe('unknown');
  });
});

describe('readHttpConfig', () => {
  const saved = { ...process.env };

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
