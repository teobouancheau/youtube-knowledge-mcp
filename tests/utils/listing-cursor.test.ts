import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/utils/listing-cursor.js';
import { YouTubeError } from '../../src/utils/errors.js';

describe('listing cursors', () => {
  it('round-trips a position', () => {
    const cursor = { v: 1 as const, start: 41, anchor: 'dQw4w9WgXcQ' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is opaque to the caller', () => {
    // Base64url so it survives a URL or a JSON string without escaping.
    expect(encodeCursor({ v: 1, start: 2, anchor: 'x' })).not.toContain('{');
  });

  const rejected = [
    ['not base64 at all', '!!!!'],
    ['valid base64 that is not JSON', Buffer.from('hello', 'utf8').toString('base64url')],
    ['JSON of the wrong shape', Buffer.from('{"start":1}', 'utf8').toString('base64url')],
    [
      'a version this build does not issue',
      Buffer.from('{"v":2,"start":1,"anchor":"a"}', 'utf8').toString('base64url'),
    ],
    [
      'a start before the first item',
      Buffer.from('{"v":1,"start":0,"anchor":"a"}', 'utf8').toString('base64url'),
    ],
  ] as const;

  for (const [name, token] of rejected) {
    it(`rejects ${name}`, () => {
      expect(() => decodeCursor(token)).toThrow(YouTubeError);
      expect(() => decodeCursor(token)).toThrow(/cursor/);
    });
  }
});
