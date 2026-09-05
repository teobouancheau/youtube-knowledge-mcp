import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jpeg } from '../fixtures/images.js';
import { YouTubeError } from '../../src/utils/errors.js';

vi.mock('../../src/utils/image-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/image-fetch.js')>();
  return { ...actual, fetchImage: vi.fn() };
});

import { fetchImage } from '../../src/utils/image-fetch.js';
import { climb, videoRungs } from '../../src/utils/thumbnail-ladder.js';

const ID = 'dQw4w9WgXcQ';
const LISTED = {
  url: `https://i.ytimg.com/vi/${ID}/hq720_custom_3.jpg?sqp=x`,
  width: 720,
  height: 404,
};
const PORTRAIT = { url: `https://i.ytimg.com/vi/${ID}/sardefault.jpg?a`, width: 405, height: 720 };

const image = (
  width: number,
  height: number
): { bytes: Buffer; contentType: string; url: string } => ({
  bytes: Buffer.from(jpeg(width, height)),
  contentType: 'image/jpeg',
  url: '',
});

beforeEach(() => {
  vi.mocked(fetchImage).mockReset();
});

describe('videoRungs', () => {
  it('tries maxresdefault first, then the listed image, then hqdefault, for a regular video', () => {
    expect(videoRungs(ID, LISTED, false, 'best').map((rung) => rung.variant)).toEqual([
      'maxresdefault',
      'listed',
      'hqdefault',
    ]);
  });

  it('requires maxresdefault to beat the listed width', () => {
    expect(videoRungs(ID, LISTED, false, 'best')[0]?.mustExceedWidth).toBe(720);
  });

  it('never probes maxresdefault for a short, whose existence and orientation are unverified', () => {
    expect(videoRungs(ID, PORTRAIT, true, 'best').map((rung) => rung.variant)).toEqual([
      'listed',
      'hqdefault',
    ]);
  });

  it('skips the larger sizes when the caller asked for the listed image', () => {
    expect(videoRungs(ID, LISTED, false, 'listed').map((rung) => rung.variant)).toEqual([
      'listed',
      'hqdefault',
    ]);
  });

  it('tries the named sizes in descending order when nothing was listed', () => {
    expect(videoRungs(ID, undefined, false, 'best').map((rung) => rung.variant)).toEqual([
      'maxresdefault',
      'sddefault',
      'hqdefault',
    ]);
    expect(videoRungs(ID, undefined, false, 'best')[0]?.mustExceedWidth).toBe(200);
  });

  it('keeps the listed URL verbatim, query string included', () => {
    expect(videoRungs(ID, LISTED, false, 'listed')[0]?.url).toBe(LISTED.url);
  });
});

describe('climb', () => {
  it('accepts maxresdefault when it decodes wider than the listed image', async () => {
    vi.mocked(fetchImage).mockResolvedValueOnce(image(1280, 720));

    const result = await climb(videoRungs(ID, LISTED, false, 'best'), 1024 * 1024);

    expect(result.rung.variant).toBe('maxresdefault');
    expect(result.probe).toMatchObject({ width: 1280, height: 720 });
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  // Whether YouTube answers a missing maxresdefault with a 404 or a small
  // placeholder is not something this code assumes; either way it falls through.
  it('falls through when maxresdefault is not wider than the listed image', async () => {
    vi.mocked(fetchImage)
      .mockResolvedValueOnce(image(120, 90))
      .mockResolvedValueOnce(image(720, 404));

    const result = await climb(videoRungs(ID, LISTED, false, 'best'), 1024 * 1024);

    expect(result.rung.variant).toBe('listed');
  });

  it('falls through on a 404', async () => {
    vi.mocked(fetchImage)
      .mockRejectedValueOnce(new YouTubeError('NOT_FOUND', 'no'))
      .mockResolvedValueOnce(image(720, 404));

    expect((await climb(videoRungs(ID, LISTED, false, 'best'), 1024 * 1024)).rung.variant).toBe(
      'listed'
    );
  });

  it('falls through when the bytes are not an image it can read', async () => {
    vi.mocked(fetchImage)
      .mockResolvedValueOnce({
        bytes: Buffer.from('not an image'),
        contentType: 'image/jpeg',
        url: '',
      })
      .mockResolvedValueOnce(image(720, 404));

    expect((await climb(videoRungs(ID, LISTED, false, 'best'), 1024 * 1024)).rung.variant).toBe(
      'listed'
    );
  });

  it.each(['RATE_LIMITED', 'TIMEOUT', 'CANCELLED'] as const)(
    'stops at once on %s',
    async (code) => {
      vi.mocked(fetchImage).mockRejectedValueOnce(new YouTubeError(code, 'stop'));

      await expect(climb(videoRungs(ID, LISTED, false, 'best'), 1024 * 1024)).rejects.toMatchObject(
        { code }
      );
      expect(fetchImage).toHaveBeenCalledTimes(1);
    }
  );

  it('reports the last failure when every rung fails', async () => {
    vi.mocked(fetchImage)
      .mockRejectedValueOnce(new YouTubeError('NOT_FOUND', 'first'))
      .mockRejectedValueOnce(new YouTubeError('FETCH_FAILED', 'second'))
      .mockRejectedValueOnce(new YouTubeError('NOT_FOUND', 'third'));

    await expect(climb(videoRungs(ID, LISTED, false, 'best'), 1024 * 1024)).rejects.toMatchObject({
      message: 'third',
    });
  });

  it('propagates an unexpected error rather than treating it as a rung failure', async () => {
    vi.mocked(fetchImage).mockRejectedValueOnce(new Error('bug'));
    await expect(climb(videoRungs(ID, LISTED, false, 'best'), 1)).rejects.toThrow('bug');
  });

  it('has nothing to try for an empty ladder', async () => {
    await expect(climb([], 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('passes the byte cap down', async () => {
    vi.mocked(fetchImage).mockResolvedValueOnce(image(1280, 720));
    await climb(videoRungs(ID, LISTED, false, 'best'), 12345);
    expect(fetchImage).toHaveBeenCalledWith(expect.any(String), { maxBytes: 12345 });
  });
});
