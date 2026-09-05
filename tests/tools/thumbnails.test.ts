import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { structuredOf, textOf } from '../helpers.js';
import { jpeg, png, webpVp8 } from '../fixtures/images.js';
import { YouTubeError } from '../../src/utils/errors.js';
import { runWithRequestContext } from '../../src/utils/context.js';
import type { VideoListItem } from '../../src/utils/youtube.js';

/**
 * The thumbnail tools end to end, against a real temporary filesystem, a
 * stubbed YouTube listing and a stubbed image host. What is worth proving is
 * the behaviour around the network: that a run can be interrupted and resumed,
 * that a lost or truncated file is fetched again and nothing else is, and that
 * every size in the manifest is the size of the bytes on disk.
 */

vi.mock('../../src/utils/youtube.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/youtube.js')>();
  return { ...actual, getChannelInfo: vi.fn(), listVideos: vi.fn() };
});
vi.mock('../../src/utils/image-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/image-fetch.js')>();
  return { ...actual, fetchImage: vi.fn() };
});
vi.mock('../../src/utils/thumbnail-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/thumbnail-store.js')>();
  return { ...actual, writeThumbnailManifest: vi.fn(actual.writeThumbnailManifest) };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});

import { getChannelInfo, listVideos } from '../../src/utils/youtube.js';
import { fetchImage } from '../../src/utils/image-fetch.js';
import { fetchChannelThumbnailsHandler } from '../../src/tools/fetch-channel-thumbnails.js';
import {
  deleteChannelThumbnailsHandler,
  listChannelThumbnailsHandler,
} from '../../src/tools/list-channel-thumbnails.js';
import { getThumbnailHandler } from '../../src/tools/get-thumbnail.js';
import { thumbnailDir, thumbnailLockPath } from '../../src/utils/thumbnail-paths.js';
import {
  ensureThumbnailDirs,
  readThumbnailManifest,
  writeThumbnailManifest,
} from '../../src/utils/thumbnail-store.js';
import { concurrencyState } from '../../src/utils/ytdlp.js';

const CHANNEL_ID = 'UCK8sQmJBp8GCxrOtXWBpyEA';
const CHANNEL = {
  name: 'Google',
  channelId: CHANNEL_ID,
  handle: '@Google',
  subscriberCount: 14_500_000,
  channelUrl: `https://www.youtube.com/channel/${CHANNEL_ID}`,
  description: '',
  avatarUrl: 'https://yt3.googleusercontent.com/avatar=s0',
  bannerUrl: 'https://yt3.googleusercontent.com/banner=s0',
};

const ids = [
  'aaaaaaaaaa1',
  'aaaaaaaaaa2',
  'aaaaaaaaaa3',
  'aaaaaaaaaa4',
  'aaaaaaaaaa5',
  'aaaaaaaaaa6',
];
const first = ids[0] ?? '';
const second = ids[1] ?? '';
const third = ids[2] ?? '';

function video(id: string, portrait = false): VideoListItem {
  const [w, h] = portrait ? [405, 720] : [720, 404];
  return {
    id,
    title: `Video ${id}`,
    duration: 86,
    durationFormatted: '1:26',
    uploadDate: '',
    url: `https://www.youtube.com/watch?v=${id}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/listed.jpg`,
    thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/listed.jpg`, width: w, height: h }],
  };
}

interface Served {
  bytes: Buffer;
  contentType: string;
  url: string;
}
type Override = (url: string) => Promise<Buffer | undefined> | Buffer | undefined;

/** A stubbed image host: maxresdefault is 1280 wide, listed images are what they claim, avatars are PNG. */
function serveImages(override: Override = () => undefined): void {
  vi.mocked(fetchImage).mockImplementation(async (url): Promise<Served> => {
    const custom = await override(url);
    if (custom !== undefined) return { bytes: custom, contentType: 'image/jpeg', url };
    const serve = (bytes: Uint8Array, contentType: string): Served => ({
      bytes: Buffer.from(bytes),
      contentType,
      url,
    });
    if (url.includes('maxresdefault')) return serve(jpeg(1280, 720), 'image/jpeg');
    if (url.includes('avatar')) return serve(png(900, 900), 'image/png');
    if (url.includes('banner')) return serve(webpVp8(2560, 424), 'image/webp');
    if (url.includes('listed')) {
      const portrait = url.includes('sssssssss') || url.includes('pppppppppp');
      return serve(jpeg(portrait ? 405 : 720, portrait ? 720 : 404), 'image/jpeg');
    }
    throw new YouTubeError('NOT_FOUND', 'no such image');
  });
}

const args = {
  channel: '@Google',
  maxVideos: 100,
  tabs: ['videos' as const],
  quality: 'best' as const,
};
const remote = { store: false };
const local = { store: true };

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'thumbnails-'));
  process.env.TEST_HOME = home;
  vi.clearAllMocks();
  vi.mocked(getChannelInfo).mockResolvedValue(CHANNEL);
  vi.mocked(listVideos).mockImplementation((url) =>
    Promise.resolve(
      url.endsWith('/shorts')
        ? [video('sssssssss01', true)]
        : ids.slice(0, 3).map((id) => video(id))
    )
  );
  serveImages();
});

afterEach(async () => {
  delete process.env.TEST_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('fetch_channel_thumbnails', () => {
  it('saves every thumbnail plus the avatar and banner, recording decoded sizes', async () => {
    const result = await fetchChannelThumbnailsHandler(args);
    const structured = structuredOf(result);

    expect(structured).toMatchObject({
      considered: 3,
      fetched: 3,
      skipped: 0,
      failed: 0,
      stoppedEarly: false,
    });
    expect(structured.avatar).toMatchObject({
      state: 'saved',
      format: 'png',
      width: 900,
      height: 900,
    });
    expect(structured.banner).toMatchObject({
      state: 'saved',
      format: 'webp',
      width: 2560,
      height: 424,
    });

    const manifest = await readThumbnailManifest(CHANNEL_ID);
    for (const id of ids.slice(0, 3)) {
      const entry = manifest?.videos[id];
      expect(entry).toMatchObject({
        state: 'saved',
        variant: 'maxresdefault',
        width: 1280,
        height: 720,
        format: 'jpg',
      });
      const file = join(thumbnailDir(CHANNEL_ID), 'videos', `${id}.jpg`);
      expect((await stat(file)).size).toBe(entry?.bytes);
    }
    expect(textOf(result)).toContain('3 of 3 saved');
    expect(result.content[1]).toMatchObject({
      type: 'resource_link',
      mimeType: 'application/json',
    });
  });

  it('saves shorts under their own directory, flagged as portrait', async () => {
    await fetchChannelThumbnailsHandler({ ...args, tabs: ['videos', 'shorts'] });

    const manifest = await readThumbnailManifest(CHANNEL_ID);
    expect(manifest?.videos.sssssssss01).toMatchObject({
      tab: 'shorts',
      isShort: true,
      variant: 'listed',
      width: 405,
      height: 720,
    });
    expect(existsSync(join(thumbnailDir(CHANNEL_ID), 'shorts', 'sssssssss01.jpg'))).toBe(true);
    expect(manifest?.tabs).toEqual(['videos', 'shorts']);
  });

  it('flags a portrait listing under the videos tab as a short too', async () => {
    vi.mocked(listVideos).mockResolvedValue([video('pppppppppp1', true)]);
    await fetchChannelThumbnailsHandler(args);
    expect((await readThumbnailManifest(CHANNEL_ID))?.videos.pppppppppp1?.isShort).toBe(true);
  });

  it('skips what is already saved on a second run and retries failures', async () => {
    serveImages((url) =>
      url.includes(third) ? Promise.reject(new YouTubeError('FETCH_FAILED', 'flaky')) : undefined
    );
    const firstRun = structuredOf(await fetchChannelThumbnailsHandler(args));
    expect(firstRun).toMatchObject({ fetched: 2, failed: 1 });
    expect(firstRun.failures).toEqual([{ videoId: third, tab: 'videos', error: 'FETCH_FAILED' }]);

    serveImages();
    const secondRun = structuredOf(await fetchChannelThumbnailsHandler(args));
    expect(secondRun).toMatchObject({ fetched: 1, skipped: 2, failed: 0 });
  });

  it('fetches again exactly the file that went missing or was truncated', async () => {
    await fetchChannelThumbnailsHandler(args);
    const lost = join(thumbnailDir(CHANNEL_ID), 'videos', `${first}.jpg`);
    const cut = join(thumbnailDir(CHANNEL_ID), 'videos', `${second}.jpg`);
    await rm(lost);
    await truncate(cut, 2);

    const result = structuredOf(await fetchChannelThumbnailsHandler(args));

    expect(result).toMatchObject({ fetched: 2, skipped: 1 });
    expect(existsSync(lost)).toBe(true);
    expect((await stat(cut)).size).toBeGreaterThan(2);
  });

  it('keeps what it fetched when the client cancels part-way', async () => {
    vi.mocked(listVideos).mockResolvedValue(ids.map((id) => video(id)));
    const controller = new AbortController();
    let served = 0;
    serveImages(() => {
      served++;
      if (served === 3) controller.abort();
      return undefined;
    });

    await expect(
      runWithRequestContext({ signal: controller.signal }, () =>
        fetchChannelThumbnailsHandler(args)
      )
    ).rejects.toThrow();

    const manifest = await readThumbnailManifest(CHANNEL_ID);
    expect(manifest).toBeDefined();
    expect(manifest?.stats.savedCount).toBeGreaterThan(0);
    expect(manifest?.stats.savedCount).toBeLessThan(6);
  });

  it('stops after repeated rate limiting and says so', async () => {
    vi.mocked(listVideos).mockResolvedValue(ids.map((id) => video(id)));
    serveImages(() =>
      Promise.reject(new YouTubeError('RATE_LIMITED', 'slow down', { retryable: true }))
    );

    const result = structuredOf(await fetchChannelThumbnailsHandler(args));

    expect(result.stoppedEarly).toBe(true);
    expect(result.stopReason).toMatch(/rate limiting/);
    expect(result.fetched).toBe(0);
    expect(textOf(await fetchChannelThumbnailsHandler(args))).toContain('Stopped early');
  });

  it('refuses while another fetch holds the lock', async () => {
    await ensureThumbnailDirs(CHANNEL_ID, ['videos']);
    await writeFile(
      thumbnailLockPath(CHANNEL_ID),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );

    await expect(fetchChannelThumbnailsHandler(args)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      nextStep: expect.stringContaining('fetch_channel_thumbnails') as string,
    });
  });

  it('records a shorts or streams tab that could not be listed, but fails on the uploads tab', async () => {
    vi.mocked(listVideos).mockImplementation((url) => {
      if (url.endsWith('/streams'))
        return Promise.reject(new YouTubeError('YTDLP_FAILED', 'no tab'));
      return Promise.resolve([video(first)]);
    });
    const result = await fetchChannelThumbnailsHandler({ ...args, tabs: ['videos', 'streams'] });
    expect(structuredOf(result).tabErrors).toEqual([{ tab: 'streams', error: 'YTDLP_FAILED' }]);
    expect(textOf(result)).toContain('streams tab could not be listed');

    vi.mocked(listVideos).mockRejectedValue(new YouTubeError('RATE_LIMITED', 'throttled'));
    await expect(fetchChannelThumbnailsHandler(args)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('runs no more fetches at once than the yt-dlp limiter allows', async () => {
    vi.mocked(listVideos).mockResolvedValue(ids.map((id) => video(id)));
    let inFlight = 0;
    let peak = 0;
    serveImages(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      inFlight--;
      return undefined;
    });

    await fetchChannelThumbnailsHandler(args);

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(concurrencyState().limit);
  });

  it('honours maxVideos and asks yt-dlp for each tab of the channel', async () => {
    vi.mocked(listVideos).mockResolvedValue(ids.map((id) => video(id)));

    const result = structuredOf(await fetchChannelThumbnailsHandler({ ...args, maxVideos: 2 }));

    expect(result.considered).toBe(2);
    expect(listVideos).toHaveBeenCalledWith(`${CHANNEL.channelUrl}/videos`, 2);
  });

  it('keeps a listed-only run to the listed image', async () => {
    await fetchChannelThumbnailsHandler({ ...args, quality: 'listed' });
    const manifest = await readThumbnailManifest(CHANNEL_ID);
    expect(manifest?.videos[first]).toMatchObject({ variant: 'listed', width: 720 });
    expect(fetchImage).not.toHaveBeenCalledWith(
      expect.stringContaining('maxresdefault'),
      expect.anything()
    );
  });

  it('records a channel image that could not be fetched without failing the run', async () => {
    serveImages((url) =>
      url.includes('banner') ? Promise.reject(new YouTubeError('NOT_FOUND', 'gone')) : undefined
    );
    const result = structuredOf(await fetchChannelThumbnailsHandler(args));
    expect(result.banner).toMatchObject({ state: 'failed', error: 'NOT_FOUND' });
    expect(result.avatar).toMatchObject({ state: 'saved' });
  });

  it('leaves the channel images alone when the listing carries none', async () => {
    vi.mocked(getChannelInfo).mockResolvedValue({
      ...CHANNEL,
      avatarUrl: undefined,
      bannerUrl: undefined,
    });
    const result = await fetchChannelThumbnailsHandler(args);
    expect(structuredOf(result)).not.toHaveProperty('avatar');
    expect(textOf(result)).toContain('Avatar: not listed');
  });

  it('checkpoints the manifest every twenty images, then once more at the end', async () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      video(`bbbbbbbbb${String(i).padStart(2, '0')}`)
    );
    vi.mocked(listVideos).mockResolvedValue(many);
    vi.mocked(writeThumbnailManifest).mockClear();

    const result = structuredOf(await fetchChannelThumbnailsHandler(args));

    expect(result.fetched).toBe(21);
    expect(writeThumbnailManifest).toHaveBeenCalledTimes(2);
  });

  it('replaces a saved file whose format changed rather than leaving two', async () => {
    await fetchChannelThumbnailsHandler(args);
    const old = join(thumbnailDir(CHANNEL_ID), 'videos', `${first}.jpg`);
    await rm(old);
    serveImages((url) => (url.includes(first) ? Buffer.from(png(1280, 720)) : undefined));

    await fetchChannelThumbnailsHandler(args);

    expect(existsSync(join(thumbnailDir(CHANNEL_ID), 'videos', `${first}.png`))).toBe(true);
    expect(existsSync(old)).toBe(false);
  });
});

describe('list_channel_thumbnails', () => {
  it('lists saved entries with absolute paths, paged and filtered', async () => {
    await fetchChannelThumbnailsHandler({ ...args, tabs: ['videos', 'shorts'] });

    const page = structuredOf(
      await listChannelThumbnailsHandler({ channel: 'google', limit: 2, offset: 0 })
    );
    expect(page).toMatchObject({ total: 4, count: 2, hasMore: true, nextOffset: 2 });
    expect(page.thumbnails).toEqual([
      expect.objectContaining({
        path: expect.stringContaining(thumbnailDir(CHANNEL_ID)) as string,
      }),
      expect.objectContaining({ path: expect.any(String) as string }),
    ]);
    expect(page.avatar).toMatchObject({ path: expect.stringContaining('avatar.png') as string });

    const shorts = structuredOf(
      await listChannelThumbnailsHandler({
        channel: CHANNEL_ID,
        tab: 'shorts',
        limit: 50,
        offset: 0,
      })
    );
    expect(shorts.total).toBe(1);

    const failed = await listChannelThumbnailsHandler({
      channel: CHANNEL_ID,
      state: 'failed',
      limit: 50,
      offset: 0,
    });
    expect(structuredOf(failed).total).toBe(0);
    expect(textOf(failed)).toContain('No entries match');
  });

  it('refuses a channel nothing was fetched for, before any network call', async () => {
    await expect(
      listChannelThumbnailsHandler({ channel: '@nobody', limit: 50, offset: 0 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getChannelInfo).not.toHaveBeenCalled();
  });
});

describe('delete_channel_thumbnails', () => {
  it('removes the directory, and then has nothing left to resolve', async () => {
    await fetchChannelThumbnailsHandler(args);
    const result = structuredOf(await deleteChannelThumbnailsHandler({ channel: '@Google' }));
    expect(result).toMatchObject({ channelId: CHANNEL_ID, deleted: true });
    expect(existsSync(thumbnailDir(CHANNEL_ID))).toBe(false);
    await expect(deleteChannelThumbnailsHandler({ channel: '@Google' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('get_thumbnail', () => {
  const forVideo = { video: first, image: 'thumbnail' as const, quality: 'best' as const };

  it('returns an image block with the decoded size for a video', async () => {
    const result = await getThumbnailHandler(forVideo, remote);

    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(structuredOf(result)).toMatchObject({
      image: 'thumbnail',
      videoId: first,
      width: 1280,
      height: 720,
      variant: 'maxresdefault',
      fromDisk: false,
    });
    expect(textOf(result)).toContain('1280x720 JPG');
  });

  it('serves a saved thumbnail from disk locally, and fetches remotely', async () => {
    await fetchChannelThumbnailsHandler(args);
    vi.mocked(fetchImage).mockClear();

    const fromDisk = structuredOf(await getThumbnailHandler(forVideo, local));
    expect(fromDisk).toMatchObject({ fromDisk: true, width: 1280 });
    expect(fetchImage).not.toHaveBeenCalled();

    expect(structuredOf(await getThumbnailHandler(forVideo, remote)).fromDisk).toBe(false);
  });

  it('fetches when the saved file is missing or unreadable', async () => {
    await fetchChannelThumbnailsHandler(args);
    const file = join(thumbnailDir(CHANNEL_ID), 'videos', `${first}.jpg`);
    await rm(file);
    expect(structuredOf(await getThumbnailHandler(forVideo, local)).fromDisk).toBe(false);

    await writeFile(file, 'garbage');
    expect(structuredOf(await getThumbnailHandler(forVideo, local)).fromDisk).toBe(false);
  });

  it('returns the avatar and banner for a channel', async () => {
    const avatar = structuredOf(
      await getThumbnailHandler({ channel: '@Google', image: 'avatar', quality: 'best' }, remote)
    );
    expect(avatar).toMatchObject({
      image: 'avatar',
      channelId: CHANNEL_ID,
      mimeType: 'image/png',
      width: 900,
      fromDisk: false,
    });

    await fetchChannelThumbnailsHandler(args);
    const banner = structuredOf(
      await getThumbnailHandler({ channel: '@Google', image: 'banner', quality: 'best' }, local)
    );
    expect(banner).toMatchObject({
      image: 'banner',
      mimeType: 'image/webp',
      width: 2560,
      fromDisk: true,
    });
  });

  it('reports a channel that lists no such image', async () => {
    vi.mocked(getChannelInfo).mockResolvedValue({ ...CHANNEL, bannerUrl: undefined });
    await expect(
      getThumbnailHandler({ channel: '@Google', image: 'banner', quality: 'best' }, remote)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses the argument combinations that make no sense, before any request', async () => {
    await expect(
      getThumbnailHandler({ image: 'thumbnail', quality: 'best' }, remote)
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      getThumbnailHandler({ image: 'avatar', quality: 'best' }, remote)
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(getChannelInfo).not.toHaveBeenCalled();
  });

  it('refuses a channel image that is not an image', async () => {
    serveImages((url) => (url.includes('avatar') ? Buffer.from('not an image') : undefined));
    await expect(
      getThumbnailHandler({ channel: '@Google', image: 'avatar', quality: 'best' }, remote)
    ).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });

  it('serves a saved channel image by handle, byte for byte', async () => {
    await fetchChannelThumbnailsHandler(args);
    const saved = await readFile(join(thumbnailDir(CHANNEL_ID), 'channel', 'avatar.png'));
    const result = await getThumbnailHandler(
      { channel: 'google', image: 'avatar', quality: 'best' },
      local
    );
    expect(result.content[1]).toMatchObject({ data: saved.toString('base64') });
  });

  it('falls through to fetching when a saved channel image is missing on disk', async () => {
    await fetchChannelThumbnailsHandler(args);
    await rm(join(thumbnailDir(CHANNEL_ID), 'channel', 'avatar.png'));
    const result = structuredOf(
      await getThumbnailHandler({ channel: 'google', image: 'avatar', quality: 'best' }, local)
    );
    expect(result.fromDisk).toBe(false);
  });
});
