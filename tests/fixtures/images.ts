/**
 * Minimal image files built in memory: enough header for the format to be
 * recognised and its dimensions read, and nothing else. Real images would be
 * binary files in the repository that nobody can review.
 */

function be16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function le16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function le24(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

/** The byte values of an ASCII tag such as `RIFF`. */
export const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));

/** SOI, an APP0 segment, a start-of-frame with the size, then EOI. */
export function jpeg(
  width: number,
  height: number,
  options: { progressive?: boolean; leadingApp1?: boolean } = {}
): Uint8Array<ArrayBuffer> {
  const app = [0xff, 0xe0, ...be16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const app1 = options.leadingApp1 ? [0xff, 0xe1, ...be16(8), ...ascii('Exif'), 0, 0] : [];
  const sof = [
    0xff,
    options.progressive ? 0xc2 : 0xc0,
    ...be16(11),
    8,
    ...be16(height),
    ...be16(width),
    1,
    1,
    0x11,
    0,
  ];
  return new Uint8Array([0xff, 0xd8, ...app1, ...app, ...sof, 0xff, 0xd9]);
}

export function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...ascii('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    2,
    0,
    0,
    0,
  ]);
}

function riff(chunk: string, payload: number[]): Uint8Array<ArrayBuffer> {
  const body = [...ascii('WEBP'), ...ascii(chunk), ...be32(payload.length).reverse(), ...payload];
  return new Uint8Array([...ascii('RIFF'), ...be32(body.length).reverse(), ...body]);
}

export function webpVp8(width: number, height: number): Uint8Array<ArrayBuffer> {
  // Frame tag (3 bytes), start code, then 14-bit width and height.
  return riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0]);
}

export function webpVp8l(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bits = (width - 1) | ((height - 1) << 14);
  const header = [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff];
  return riff('VP8L', [...header, 0, 0, 0, 0, 0]);
}

export function webpVp8x(width: number, height: number): Uint8Array<ArrayBuffer> {
  return riff('VP8X', [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1), 0, 0]);
}
