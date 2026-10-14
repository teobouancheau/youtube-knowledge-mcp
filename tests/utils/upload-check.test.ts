import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});
vi.mock('../../src/utils/harvest-catalog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/harvest-catalog.js')>()),
  listTab: vi.fn(),
}));
vi.mock('../../src/utils/youtube-channel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/youtube-channel.js')>()),
  getChannelInfo: vi.fn(),
}));

import { closeStore, getStore } from '../../src/utils/store.js';
import { listTab } from '../../src/utils/harvest-catalog.js';
import { getChannelInfo } from '../../src/utils/youtube-channel.js';
import { coverageOf } from '../../src/utils/coverage.js';
import { saveReceipt } from '../../src/utils/harvest-receipts.js';
import { YouTubeError } from '../../src/utils/errors.js';
import { checkNewUploads } from '../../src/utils/upload-check.js';

const CHANNEL_ID = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CHANNEL = {
  name: 'Example',
  channelId: CHANNEL_ID,
  handle: '@example',
  subscriberCount: 1,
  channelUrl: `https://www.youtube.com/channel/${CHANNEL_ID}`,
  description: '',
};

type Store = Awaited<ReturnType<typeof getStore>>;

const entry = (id: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id, title: `Title ${id}`, duration: 60, ...extra });

async function catalogue(videos: string[], complete = true): Promise<Store> {
  const store = await getStore();
  store.exec(
    `INSERT INTO channel(channel_id, name, first_seen_at, updated_at) VALUES ('${CHANNEL_ID}','Example',1,1)`
  );
  const insert = store.prepare(
    "INSERT INTO video (video_id, channel_id, title, tab, also_in_tabs, catalog_rank) VALUES (?,?,?,'videos','[]',?)"
  );
  videos.forEach((id, rank) => {
    insert.run(id, CHANNEL_ID, `Title ${id}`, rank);
  });
  saveReceipt(
    store,
    coverageOf({
      scope: 'channel-catalog',
      targetId: CHANNEL_ID,
      have: videos.length,
      source: 'test',
      ...(complete
        ? {
            expected: { value: videos.length, source: 'source-exhausted' as const },
            ranToExhaustion: true,
          }
        : {}),
    })
  );
  return store;
}

function listings(byTab: Record<string, string[]>): void {
  vi.mocked(listTab).mockImplementation((_url, tab) => {
    const lines = byTab[tab];
    if (lines === undefined) {
      return Promise.reject(new YouTubeError('NOT_FOUND', 'This channel does not have that tab.'));
    }
    return Promise.resolve(lines.join('\n'));
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-uploads-'));
  vi.clearAllMocks();
  vi.mocked(getChannelInfo).mockResolvedValue(CHANNEL);
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
});

describe('checkNewUploads', () => {
  it('names the videos the channel lists that the catalogue has never seen', async () => {
    const store = await catalogue(['old1', 'old2']);
    listings({ videos: [entry('new1'), entry('old1'), entry('old2')], shorts: [] });

    const result = await checkNewUploads(store, '@example', { lookback: 30 });

    expect(result.newVideos).toEqual([
      expect.objectContaining({
        videoId: 'new1',
        title: 'Title new1',
        tab: 'videos',
        url: 'https://www.youtube.com/watch?v=new1',
        durationSeconds: 60,
      }),
    ]);
  });

  it('names a video listed under two tabs once, under the first tab that lists it', async () => {
    const store = await catalogue(['old1']);
    listings({ videos: [entry('new1')], shorts: [entry('new1'), entry('new2')] });

    const result = await checkNewUploads(store, '@example', { lookback: 30 });

    expect(result.newVideos.map((video) => [video.videoId, video.tab])).toEqual([
      ['new1', 'videos'],
      ['new2', 'shorts'],
    ]);
  });

  it('looks only as far back as asked, per tab, and says how far it looked', async () => {
    const store = await catalogue(['old1']);
    listings({ videos: [entry('old1')], shorts: [] });

    const result = await checkNewUploads(store, '@example', { lookback: 7 });

    expect(listTab).toHaveBeenCalledWith(CHANNEL.channelUrl, 'videos', 7, expect.any(String));
    expect(result.checked).toContainEqual({ tab: 'videos', listed: 1 });
    expect(result.lookback).toBe(7);
  });

  it('says when the catalogue was last whole, so "nothing new" is read against its age', async () => {
    const store = await catalogue(['old1'], true);
    listings({ videos: [entry('old1')] });

    const result = await checkNewUploads(store, '@example', { lookback: 30 });

    expect(result.catalogComplete).toBe(true);
    expect(result.catalogHarvestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('says so when the catalogue was never whole', async () => {
    const store = await catalogue(['old1'], false);
    listings({ videos: [entry('old1')] });

    expect((await checkNewUploads(store, '@example', { lookback: 30 })).catalogComplete).toBe(
      false
    );
  });

  it('treats a tab the channel does not have as an empty answer, not a failure', async () => {
    const store = await catalogue(['old1']);
    listings({ videos: [entry('old1')] });

    const result = await checkNewUploads(store, '@example', { lookback: 30 });

    expect(result.checked.find((tab) => tab.tab === 'podcasts')).toEqual({
      tab: 'podcasts',
      listed: 0,
    });
  });

  it('reports a tab that failed for another reason, and still answers for the others', async () => {
    const store = await catalogue(['old1']);
    vi.mocked(listTab).mockImplementation((_url, tab) =>
      tab === 'shorts'
        ? Promise.reject(new YouTubeError('RATE_LIMITED', 'Slow down.'))
        : Promise.resolve(entry('old1'))
    );

    const result = await checkNewUploads(store, '@example', { lookback: 30 });

    expect(result.checked.find((tab) => tab.tab === 'shorts')).toMatchObject({
      listed: 0,
      error: 'Slow down.',
    });
    expect(result.newVideos).toEqual([]);
  });

  it('fails when every tab failed, rather than reporting nothing new', async () => {
    const store = await catalogue(['old1']);
    vi.mocked(listTab).mockRejectedValue(new YouTubeError('BOT_CHECK', 'Sign in to confirm.'));

    await expect(checkNewUploads(store, '@example', { lookback: 30 })).rejects.toMatchObject({
      code: 'BOT_CHECK',
    });
  });

  it('refuses a channel that has not been catalogued, and says what to do first', async () => {
    const store = await getStore();

    await expect(checkNewUploads(store, '@example', { lookback: 30 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      nextStep: expect.stringContaining('harvest_channel'),
    });
    expect(listTab).not.toHaveBeenCalled();
  });

  it('writes nothing: finding what is new is not the same as adding it', async () => {
    const store = await catalogue(['old1']);
    listings({ videos: [entry('new1'), entry('old1')] });

    await checkNewUploads(store, '@example', { lookback: 30 });

    expect(store.prepare('SELECT COUNT(*) AS n FROM video').get()).toEqual({ n: 1 });
  });
});
