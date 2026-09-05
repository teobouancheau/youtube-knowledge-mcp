/**
 * Reading an image's format and size from its first bytes.
 *
 * The manifest a thumbnail job writes records what was actually saved — a
 * JPEG of 1280 by 720, say — and it must not take that from the URL's name or
 * the server's Content-Type, both of which describe what was asked for rather
 * than what arrived. Three container formats cover what YouTube's image hosts
 * serve; anything else is reported as unknown rather than guessed.
 */

export type ImageFormat = 'jpg' | 'png' | 'webp';

export interface ImageProbe {
  format: ImageFormat;
  width: number;
  height: number;
  mimeType: string;
}

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: number[], at = 0): boolean {
  return signature.every((byte, index) => bytes[at + index] === byte);
}

function ascii(bytes: Uint8Array, from: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(from, from + length));
}

/** Every caller checks the length first, so a read here is always in range. */
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function be16(bytes: Uint8Array, at: number): number {
  return view(bytes).getUint16(at);
}

function be32(bytes: Uint8Array, at: number): number {
  return view(bytes).getUint32(at);
}

function le16(bytes: Uint8Array, at: number): number {
  return view(bytes).getUint16(at, true);
}

function le24(bytes: Uint8Array, at: number): number {
  return le16(bytes, at) | (view(bytes).getUint8(at + 2) << 16);
}

/** Start-of-frame markers carry the dimensions; C4, C8 and CC are other things. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function probeJpeg(bytes: Uint8Array): ImageProbe | undefined {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = view(bytes).getUint8(at + 1);

    // Standalone markers have no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // Scan data or end of image: no frame header was found before it.
    if (marker === 0xda || marker === 0xd9) return undefined;

    if (isStartOfFrame(marker)) {
      return sized('jpg', 'image/jpeg', be16(bytes, at + 7), be16(bytes, at + 5));
    }
    at += 2 + be16(bytes, at + 2);
  }
  return undefined;
}

function probePng(bytes: Uint8Array): ImageProbe | undefined {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return undefined;
  return sized('png', 'image/png', be32(bytes, 16), be32(bytes, 20));
}

function probeWebp(bytes: Uint8Array): ImageProbe | undefined {
  if (bytes.length < 30 || ascii(bytes, 8, 4) !== 'WEBP') return undefined;

  switch (ascii(bytes, 12, 4)) {
    case 'VP8 ':
      return sized('webp', 'image/webp', le16(bytes, 26) & 0x3fff, le16(bytes, 28) & 0x3fff);
    case 'VP8L': {
      const bits = view(bytes).getUint32(21, true);
      return sized('webp', 'image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    case 'VP8X':
      return sized('webp', 'image/webp', le24(bytes, 24) + 1, le24(bytes, 27) + 1);
    default:
      return undefined;
  }
}

function sized(
  format: ImageFormat,
  mimeType: string,
  width: number,
  height: number
): ImageProbe | undefined {
  return width > 0 && height > 0 ? { format, mimeType, width, height } : undefined;
}

/** The format and pixel size of an image, or `undefined` when the bytes are not one this reads. */
export function probeImage(bytes: Uint8Array): ImageProbe | undefined {
  if (startsWith(bytes, JPEG_SIGNATURE)) return probeJpeg(bytes);
  if (startsWith(bytes, PNG_SIGNATURE)) return probePng(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF') return probeWebp(bytes);
  return undefined;
}
