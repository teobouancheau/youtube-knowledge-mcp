import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IMAGE_HOSTS,
  assertImageUrl,
  fetchImage,
  MAX_IMAGE_BYTES,
} from '../../src/utils/image-fetch.js';
import { runWithRequestContext } from '../../src/utils/context.js';
import { jpeg } from '../fixtures/images.js';

const URL_OK = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg';

function imageResponse(
  bytes: Uint8Array<ArrayBuffer> = jpeg(1280, 720),
  init: ResponseInit = {}
): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.byteLength) },
    ...init,
  });
}

const fetchMock = vi.fn<typeof fetch>();

/** A fetch that never answers and fails with the signal's own reason when aborted. */
function abortable(before?: () => void): typeof fetch {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const reason: unknown = init.signal?.reason;
        reject(reason instanceof Error ? reason : new Error('aborted'));
      });
      before?.();
    });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assertImageUrl', () => {
  it.each(IMAGE_HOSTS)('accepts https on %s', (host) => {
    expect(assertImageUrl(`https://${host}/x.jpg`).hostname).toBe(host);
  });

  it.each([
    ['http', 'http://i.ytimg.com/x.jpg'],
    ['another host', 'https://evil.example/x.jpg'],
    ['a look-alike host', 'https://i.ytimg.com.evil.example/x.jpg'],
    ['credentials', 'https://user:pw@i.ytimg.com/x.jpg'],
    ['not a URL', 'nope'],
    ['a very long value', 'https://evil.example/' + 'x'.repeat(300)],
  ])('rejects %s', (_label, input) => {
    expect(() => assertImageUrl(input)).toThrow(/not a YouTube image URL/);
  });
});

describe('fetchImage', () => {
  it('returns the bytes, content type and final URL', async () => {
    fetchMock.mockResolvedValue(imageResponse());

    const image = await fetchImage(URL_OK);

    expect(image.bytes.byteLength).toBe(jpeg(1280, 720).byteLength);
    expect(image.contentType).toBe('image/jpeg');
    expect(image.url).toBe(URL_OK);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it('refuses a host off the allowlist before any request', async () => {
    await expect(fetchImage('https://evil.example/x.jpg')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows a redirect only to an allowlisted host', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://yt3.ggpht.com/moved.jpg' },
        })
      )
      .mockResolvedValueOnce(imageResponse());

    const image = await fetchImage(URL_OK);

    expect(image.url).toBe('https://yt3.ggpht.com/moved.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses to follow a redirect off the allowlist', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })
    );

    await expect(fetchImage(URL_OK)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after too many redirects, and on a redirect without a location', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 301, headers: { location: 'https://i.ytimg.com/again.jpg' } })
    );
    await expect(fetchImage(URL_OK)).rejects.toMatchObject({ code: 'FETCH_FAILED' });

    fetchMock.mockResolvedValue(new Response(null, { status: 301 }));
    await expect(fetchImage(URL_OK)).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });

  it('reports 404 as NOT_FOUND so a ladder can move on', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(fetchImage(URL_OK)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports 429 as a retryable RATE_LIMITED', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));
    await expect(fetchImage(URL_OK)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
  });

  it('reports any other failure status as FETCH_FAILED without the body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>secret</html>', { status: 500 }));
    const error = await fetchImage(URL_OK).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'FETCH_FAILED' });
    expect((error as Error).message).not.toContain('secret');
  });

  it('refuses a response that is not an image', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    );
    await expect(fetchImage(URL_OK)).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });

  it('refuses a declared size over the cap before reading the body', async () => {
    fetchMock.mockResolvedValue(
      new Response(jpeg(1, 1), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_IMAGE_BYTES + 1) },
      })
    );
    await expect(fetchImage(URL_OK)).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });

  it('stops reading a body that grows past the cap whatever the header said', async () => {
    const big = new Uint8Array(64 * 1024);
    fetchMock.mockResolvedValue(
      new Response(new Blob([big, big, big]).stream(), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '10' },
      })
    );
    await expect(fetchImage(URL_OK, { maxBytes: 100 * 1024 })).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    });
  });

  it('refuses a response with no content type at all', async () => {
    fetchMock.mockResolvedValue(new Response(jpeg(1, 1), { status: 200 }));
    await expect(fetchImage(URL_OK)).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });

  it('reports a body that fails part-way through as FETCH_FAILED', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    fetchMock.mockResolvedValue(
      new Response(broken, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    );

    const error = await fetchImage(URL_OK).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'FETCH_FAILED' });
    expect((error as Error).message).not.toContain('connection reset');
  });

  it('treats a missing body as empty', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    );
    expect((await fetchImage(URL_OK)).bytes.byteLength).toBe(0);
  });

  it('reports a timeout as TIMEOUT', async () => {
    fetchMock.mockImplementation(abortable());
    await expect(fetchImage(URL_OK, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('reports a cancelled request as CANCELLED', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      abortable(() => {
        controller.abort();
      })
    );

    await expect(
      runWithRequestContext({ signal: controller.signal }, () => fetchImage(URL_OK))
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('reports a network failure as FETCH_FAILED', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchImage(URL_OK)).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });
});
