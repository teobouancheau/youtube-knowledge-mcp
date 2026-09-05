import { currentContext } from './context.js';
import { YouTubeError } from './errors.js';

/**
 * The one place this server fetches anything over HTTP itself.
 *
 * Everything else goes through yt-dlp. Thumbnails are the exception because
 * their URLs are known from a single channel listing, and asking yt-dlp to
 * extract each video just to download its image would multiply the requests
 * YouTube sees by the size of the channel. The fetch is deliberately narrow:
 * an allowlist of image hosts, https only, redirects re-checked hop by hop, a
 * timeout, a byte cap enforced while reading, and an image content type.
 */

export const IMAGE_HOSTS = ['i.ytimg.com', 'yt3.googleusercontent.com', 'yt3.ggpht.com'] as const;
export const IMAGE_TIMEOUT_MS = 20_000;
/** Cap for images written to disk. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Cap for images returned inline as base64; a 1280x720 JPEG is about 140 KB. */
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const HOST_SET = new Set<string>(IMAGE_HOSTS);

export interface FetchImageOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export interface FetchedImage {
  bytes: Buffer;
  contentType: string;
  /** The URL the bytes came from, after any redirects. */
  url: string;
}

/** Validate an image URL against the allowlist, returning it parsed. */
export function assertImageUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw notAllowed(input);
  }
  const allowed =
    url.protocol === 'https:' &&
    HOST_SET.has(url.hostname.toLowerCase()) &&
    url.username === '' &&
    url.password === '';
  if (!allowed) throw notAllowed(input);
  return url;
}

function notAllowed(input: string): YouTubeError {
  const shown = input.length > 96 ? `${input.slice(0, 93)}...` : input;
  return new YouTubeError('INVALID_INPUT', `"${shown}" is not a YouTube image URL.`, {
    nextStep: `Images are only fetched over https from ${IMAGE_HOSTS.join(', ')}.`,
  });
}

function failed(message: string, cause?: unknown): YouTubeError {
  return new YouTubeError('FETCH_FAILED', message, {
    nextStep: 'Retry later; if it keeps failing, the image may have been removed.',
    cause,
  });
}

/** Fetch one image into memory, or throw a typed error saying why not. */
export async function fetchImage(
  input: string,
  options: FetchImageOptions = {}
): Promise<FetchedImage> {
  const { maxBytes = MAX_IMAGE_BYTES, timeoutMs = IMAGE_TIMEOUT_MS } = options;
  const request = currentContext().signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = request === undefined ? timeout : AbortSignal.any([timeout, request]);

  let url = assertImageUrl(input);

  for (let hop = 0; ; hop++) {
    const response = await send(url, signal, request);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null || hop >= MAX_REDIRECTS)
        throw failed('The image URL redirected too far.');
      // Re-validated: a redirect is a URL the server chose, not the caller.
      url = assertImageUrl(new URL(location, url).toString());
      continue;
    }

    if (response.status === 404)
      throw new YouTubeError('NOT_FOUND', 'There is no image at that size.');
    if (response.status === 429) {
      throw new YouTubeError('RATE_LIMITED', 'YouTube is rate limiting image downloads.', {
        nextStep: 'Wait a minute before retrying.',
        retryable: true,
      });
    }
    if (!response.ok) throw failed(`The image host answered ${response.status}.`);

    const contentType = mediaType(response.headers.get('content-type') ?? '');
    if (!contentType.startsWith('image/')) throw failed('The response was not an image.');

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw failed(`The image is larger than ${maxBytes} bytes.`);

    return {
      bytes: await readCapped(response, maxBytes, signal, request),
      contentType,
      url: url.toString(),
    };
  }
}

async function send(
  url: URL,
  signal: AbortSignal,
  request: AbortSignal | undefined
): Promise<Response> {
  try {
    return await fetch(url, { redirect: 'manual', signal });
  } catch (error) {
    throw translate(error, request);
  }
}

/** The media type of a Content-Type header, without its parameters. */
function mediaType(header: string): string {
  const semicolon = header.indexOf(';');
  return header.slice(0, semicolon === -1 ? header.length : semicolon).trim();
}

/** Read the body, refusing to go past the cap whatever Content-Length claimed. */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  request: AbortSignal | undefined
): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);

  // A reader rather than `for await`: the cap has to cancel the stream from
  // inside the loop, and the async iterator holds the lock that cancel needs.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw failed(`The image is larger than ${maxBytes} bytes.`);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof YouTubeError) throw error;
    throw translate(error, request, signal);
  }
  return Buffer.concat(chunks);
}

function translate(
  error: unknown,
  request: AbortSignal | undefined,
  signal?: AbortSignal
): YouTubeError {
  if (request?.aborted === true) return new YouTubeError('CANCELLED', 'The request was cancelled.');
  const timedOut =
    (error instanceof Error && error.name === 'TimeoutError') || signal?.aborted === true;
  if (timedOut) {
    return new YouTubeError('TIMEOUT', 'The image host did not respond in time.', {
      nextStep: 'Retry; the host may be slow.',
      retryable: true,
    });
  }
  return failed('The image could not be downloaded.', error);
}
