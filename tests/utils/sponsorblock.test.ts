import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  type SponsorSegment,
  SPONSOR_CATEGORIES,
  coveredSeconds,
  fetchSponsorSegments,
  hashPrefix,
} from '../../src/utils/sponsorblock.js';

const VIDEO = 'dQw4w9WgXcQ';

const entry = (videoID: string, segments: unknown[]): unknown => ({ videoID, segments });

const segment = (category: string, start: number, end: number, votes = 3): unknown => ({
  category,
  actionType: 'skip',
  segment: [start, end],
  UUID: `uuid-${category}-${String(start)}`,
  videoDuration: 212,
  locked: 0,
  votes,
  description: '',
});

function respond(body: unknown, status = 200): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  // A fresh Response per call: a body can be read only once.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(new Response(text, { status })))
  );
}

function requestedUrl(): URL {
  const input = vi.mocked(fetch).mock.calls[0]?.[0];
  if (input === undefined) throw new Error('fetch was not called');
  return new URL(input instanceof Request ? input.url : input.toString());
}

beforeEach(() => {
  respond([entry(VIDEO, [segment('sponsor', 30, 60)])]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('coveredSeconds', () => {
  const span = (startSeconds: number, endSeconds: number): SponsorSegment => ({
    category: 'sponsor',
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    votes: 1,
  });

  it('adds up separate segments', () => {
    expect(coveredSeconds([span(0, 10), span(20, 25)])).toBe(15);
  });

  it('counts an overlap once, so the total cannot exceed what is marked', () => {
    // A sponsor read inside a self-promotion, and a second submission of the same range.
    expect(coveredSeconds([span(10, 40), span(15, 25), span(10, 40), span(35, 50)])).toBe(40);
  });

  it('does not depend on the order it is given', () => {
    expect(coveredSeconds([span(35, 50), span(10, 40)])).toBe(40);
  });

  it('is nothing for no segments', () => {
    expect(coveredSeconds([])).toBe(0);
  });
});

describe('hashPrefix', () => {
  it('is the first four hex digits of the SHA-256 of the video id', () => {
    // SponsorBlock's API is queried by this prefix, so it never learns which video of
    // the several sharing it was asked about.
    expect(hashPrefix(VIDEO)).toBe('5f6b');
  });
});

describe('fetchSponsorSegments', () => {
  it('asks by hash prefix, never by the video id itself', async () => {
    await fetchSponsorSegments(VIDEO);

    const url = requestedUrl();
    expect(url.origin).toBe('https://sponsor.ajay.app');
    expect(url.pathname).toBe('/api/skipSegments/5f6b');
    expect(url.toString()).not.toContain(VIDEO);
  });

  it('asks for the categories named, as the JSON array the API expects', async () => {
    await fetchSponsorSegments(VIDEO, ['sponsor', 'intro']);

    expect(JSON.parse(requestedUrl().searchParams.get('categories') ?? '[]')).toEqual([
      'sponsor',
      'intro',
    ]);
  });

  it('asks for every category when none is named', async () => {
    await fetchSponsorSegments(VIDEO);

    expect(JSON.parse(requestedUrl().searchParams.get('categories') ?? '[]')).toEqual([
      ...SPONSOR_CATEGORIES,
    ]);
  });

  it('keeps only the entry for this video, since a prefix is shared by several', async () => {
    respond([
      entry('someoneelse1', [segment('intro', 0, 5)]),
      entry(VIDEO, [segment('sponsor', 30, 60)]),
    ]);

    const segments = await fetchSponsorSegments(VIDEO);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ category: 'sponsor', startSeconds: 30, endSeconds: 60 });
  });

  it('returns the segments in the order they occur, with their votes', async () => {
    respond([entry(VIDEO, [segment('outro', 200, 212, 1), segment('intro', 0, 10, 9)])]);

    const segments = await fetchSponsorSegments(VIDEO);

    expect(segments.map((s) => s.category)).toEqual(['intro', 'outro']);
    expect(segments[0]).toMatchObject({ votes: 9, durationSeconds: 10 });
  });

  it('returns nothing when the video has no segments, whether the API says 404 or omits it', async () => {
    respond('Not Found', 404);
    expect(await fetchSponsorSegments(VIDEO)).toEqual([]);

    respond([entry('someoneelse1', [segment('intro', 0, 5)])]);
    expect(await fetchSponsorSegments(VIDEO)).toEqual([]);
  });

  it('reports a failing service as a fetch failure, not as an empty video', async () => {
    respond('upstream broke', 503);

    await expect(fetchSponsorSegments(VIDEO)).rejects.toMatchObject({
      code: 'FETCH_FAILED',
      message: expect.stringContaining('503'),
    });
  });

  it('reports a network failure as a fetch failure and keeps the cause', async () => {
    const cause = new Error('socket hang up');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));

    await expect(fetchSponsorSegments(VIDEO)).rejects.toMatchObject({
      code: 'FETCH_FAILED',
      cause,
    });
  });

  it('never follows a redirect, since the one host it talks to has no reason to send one', async () => {
    await fetchSponsorSegments(VIDEO);

    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.redirect).toBe('error');
  });

  it('stops reading a body that grows past the cap, rather than holding all of it', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1_000_000));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    await expect(fetchSponsorSegments(VIDEO)).rejects.toMatchObject({
      code: 'FETCH_FAILED',
      message: expect.stringContaining('too much data'),
    });
    // It read about the cap's worth and stopped; an unbounded read would never return.
    expect(sent).toBeLessThan(20);
  });

  it('refuses an answer that is not the shape it was promised', async () => {
    respond('<html>captive portal</html>');
    await expect(fetchSponsorSegments(VIDEO)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });

    respond({ videoID: VIDEO });
    await expect(fetchSponsorSegments(VIDEO)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('refuses a video id that is not one, before any request is made', async () => {
    await expect(fetchSponsorSegments('../etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives up on a service that never answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation timed out', 'TimeoutError'));
            });
          })
      )
    );

    await expect(fetchSponsorSegments(VIDEO, undefined, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});
