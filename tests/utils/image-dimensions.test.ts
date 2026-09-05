import { describe, it, expect } from 'vitest';
import { probeImage } from '../../src/utils/image-dimensions.js';
import { ascii, jpeg, png, webpVp8, webpVp8l, webpVp8x } from '../fixtures/images.js';

describe('probeImage', () => {
  it.each([
    ['a baseline JPEG', jpeg(1280, 720), 'jpg', 'image/jpeg', 1280, 720],
    ['a progressive JPEG', jpeg(640, 480, { progressive: true }), 'jpg', 'image/jpeg', 640, 480],
    [
      'a JPEG with an APP1 segment before the frame',
      jpeg(405, 720, { leadingApp1: true }),
      'jpg',
      'image/jpeg',
      405,
      720,
    ],
    ['a PNG', png(900, 900), 'png', 'image/png', 900, 900],
    ['a lossy WebP', webpVp8(2560, 424), 'webp', 'image/webp', 2560, 424],
    ['a lossless WebP', webpVp8l(360, 202), 'webp', 'image/webp', 360, 202],
    ['an extended WebP', webpVp8x(1920, 1080), 'webp', 'image/webp', 1920, 1080],
  ])('reads %s', (_label, bytes, format, mimeType, width, height) => {
    expect(probeImage(bytes)).toEqual({ format, mimeType, width, height });
  });

  it.each([
    ['garbage', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])],
    ['an empty buffer', new Uint8Array()],
    ['a truncated JPEG', jpeg(100, 100).subarray(0, 6)],
    [
      'a JPEG that reaches scan data without a frame',
      new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0, 0, 0]),
    ],
    [
      'a JPEG whose segment chain breaks',
      // A valid signature and APP0, then a byte where the next marker should be.
      new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0x12, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11,
      ]),
    ],
    ['a truncated PNG', png(10, 10).subarray(0, 20)],
    [
      'a RIFF that is not WebP',
      new Uint8Array(ascii('RIFF').concat([0, 0, 0, 0], ascii('WAVE'), new Array(20).fill(0))),
    ],
    [
      'a WebP with an unknown chunk',
      new Uint8Array(ascii('RIFF').concat([0, 0, 0, 0], ascii('WEBPXXXX'), new Array(20).fill(0))),
    ],
    ['a zero-sized PNG', png(0, 10)],
  ])('reports %s as unknown', (_label, bytes) => {
    expect(probeImage(bytes)).toBeUndefined();
  });

  it('skips restart and standalone markers inside a JPEG', () => {
    const withRestart = new Uint8Array([0xff, 0xd8, 0xff, 0xd0, ...jpeg(8, 4).subarray(2)]);
    expect(probeImage(withRestart)).toMatchObject({ width: 8, height: 4 });
  });
});
