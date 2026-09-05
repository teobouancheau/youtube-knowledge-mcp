import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jpeg } from '../fixtures/images.js';
import type { VideoListItem } from '../../src/utils/youtube.js';

vi.mock('../../src/utils/image-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/image-fetch.js')>();
  return { ...actual, fetchImage: vi.fn() };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});

import { fetchImage } from '../../src/utils/image-fetch.js';
import { fetchOne, reconciled } from '../../src/utils/thumbnail-entry.js';
import { ensureThumbnailDirs } from '../../src/utils/thumbnail-store.js';

const CHANNEL_ID = 'UCK8sQmJBp8GCxrOtXWBpyEA';

function video(id: string, overrides: Partial<VideoListItem> = {}): VideoListItem {
  return {
    id,
    title: `Video ${id}`,
    duration: 60,
    durationFormatted: '1:00',
    uploadDate: '',
    url: `https://www.youtube.com/watch?v=${id}`,
    ...overrides,
  };
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'thumbnail-entry-'));
  process.env.TEST_HOME = home;
  await ensureThumbnailDirs(CHANNEL_ID, ['videos']);
  vi.mocked(fetchImage).mockReset();
});

afterEach(async () => {
  delete process.env.TEST_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('reconciled', () => {
  it('records a video with no listed thumbnail, live status or size as pending with only what it knows', async () => {
    const entries = await reconciled(CHANNEL_ID, undefined, [
      { tab: 'videos', videos: [video('aaaaaaaaaa1')] },
    ]);

    expect(entries.get('aaaaaaaaaa1')).toEqual({
      videoId: 'aaaaaaaaaa1',
      title: 'Video aaaaaaaaaa1',
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaa1',
      tab: 'videos',
      isShort: false,
      durationSeconds: 60,
      state: 'pending',
    });
  });

  it('keeps the live status, and a listed image whose size is only partly known', async () => {
    const entries = await reconciled(CHANNEL_ID, undefined, [
      {
        tab: 'streams',
        videos: [
          video('aaaaaaaaaa2', {
            liveStatus: 'was_live',
            thumbnails: [
              { url: 'https://i.ytimg.com/vi/aaaaaaaaaa2/l.jpg', width: 640, height: null },
            ],
          }),
        ],
      },
    ]);

    expect(entries.get('aaaaaaaaaa2')).toMatchObject({
      tab: 'streams',
      liveStatus: 'was_live',
      listedUrl: 'https://i.ytimg.com/vi/aaaaaaaaaa2/l.jpg',
      listedWidth: 640,
      isShort: false,
    });
    expect(entries.get('aaaaaaaaaa2')).not.toHaveProperty('listedHeight');
  });

  it('keeps the first record when a video is listed under two tabs', async () => {
    const entries = await reconciled(CHANNEL_ID, undefined, [
      { tab: 'videos', videos: [video('aaaaaaaaaa3')] },
      { tab: 'streams', videos: [video('aaaaaaaaaa3')] },
    ]);
    expect(entries.get('aaaaaaaaaa3')?.tab).toBe('videos');
  });
});

describe('fetchOne', () => {
  it('climbs from the named sizes when nothing was listed', async () => {
    vi.mocked(fetchImage).mockResolvedValue({
      bytes: Buffer.from(jpeg(1280, 720)),
      contentType: 'image/jpeg',
      url: '',
    });
    const [entry] = [
      ...(
        await reconciled(CHANNEL_ID, undefined, [{ tab: 'videos', videos: [video('aaaaaaaaaa4')] }])
      ).values(),
    ];

    const updated = await fetchOne(
      CHANNEL_ID,
      entry ?? {
        videoId: '',
        title: '',
        url: '',
        tab: 'videos',
        isShort: false,
        durationSeconds: 0,
        state: 'pending',
      },
      'best'
    );

    expect(updated).toMatchObject({ state: 'saved', variant: 'maxresdefault', width: 1280 });
    expect(fetchImage).toHaveBeenCalledWith(
      expect.stringContaining('maxresdefault'),
      expect.anything()
    );
  });

  it('passes a listed image without a recorded size to the ladder unsized', async () => {
    vi.mocked(fetchImage).mockResolvedValue({
      bytes: Buffer.from(jpeg(720, 404)),
      contentType: 'image/jpeg',
      url: '',
    });

    const updated = await fetchOne(
      CHANNEL_ID,
      {
        videoId: 'aaaaaaaaaa5',
        title: 't',
        url: 'u',
        tab: 'videos',
        isShort: false,
        durationSeconds: 1,
        listedUrl: 'https://i.ytimg.com/vi/aaaaaaaaaa5/l.jpg',
        state: 'pending',
      },
      'listed'
    );

    expect(updated).toMatchObject({ state: 'saved', variant: 'listed', width: 720 });
  });
});
