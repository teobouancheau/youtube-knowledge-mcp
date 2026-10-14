import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});
vi.mock('../../src/utils/video-stats.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/video-stats.js')>()),
  fetchVideoStatsRow: vi.fn(),
}));
vi.mock('../../src/utils/youtube-channel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/youtube-channel.js')>()),
  getChannelInfo: vi.fn(),
}));

import { closeStore, getStore } from '../../src/utils/store.js';
import { fetchVideoStatsRow } from '../../src/utils/video-stats.js';
import { getChannelInfo } from '../../src/utils/youtube-channel.js';
import { coverageOf } from '../../src/utils/coverage.js';
import { readReceipt, saveReceipt } from '../../src/utils/harvest-receipts.js';
import { YouTubeError } from '../../src/utils/errors.js';
import { harvestDetails } from '../../src/utils/harvest-details.js';

const CHANNEL = {
  name: 'Example',
  channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
  handle: '@example',
  subscriberCount: 1,
  channelUrl: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
  description: '',
};

type Store = Awaited<ReturnType<typeof getStore>>;

async function seed(videos: string[], options: { catalogComplete?: boolean } = {}): Promise<Store> {
  const store = await getStore();
  store.exec(
    "INSERT INTO channel(channel_id, name, first_seen_at, updated_at) VALUES ('UCaaaaaaaaaaaaaaaaaaaaaa','Example',1,1)"
  );
  const insert = store.prepare(
    "INSERT INTO video (video_id, channel_id, title, tab, also_in_tabs, catalog_rank) VALUES (?,?,?,'videos','[]',?)"
  );
  videos.forEach((id, rank) => {
    insert.run(id, 'UCaaaaaaaaaaaaaaaaaaaaaa', `Title ${id}`, rank);
  });
  saveReceipt(
    store,
    coverageOf({
      scope: 'channel-catalog',
      targetId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
      have: videos.length,
      source: 'test',
      ...(options.catalogComplete === false
        ? {}
        : {
            expected: { value: videos.length, source: 'source-exhausted' as const },
            ranToExhaustion: true,
          }),
    })
  );
  return store;
}

function readable(): void {
  vi.mocked(fetchVideoStatsRow).mockImplementation((id) =>
    Promise.resolve({ id, title: `Title ${id}`, comment_count: 10, view_count: 100 })
  );
}

function detailed(store: Store): string[] {
  return (
    store
      .prepare('SELECT video_id FROM video WHERE detail_at IS NOT NULL ORDER BY video_id')
      .all() as { video_id: string }[]
  ).map((row) => row.video_id);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-harvest-details-'));
  vi.clearAllMocks();
  vi.mocked(getChannelInfo).mockResolvedValue(CHANNEL);
  readable();
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
});

describe('harvestDetails', () => {
  it('reads the catalogued videos nobody has read yet, up to the cap, in catalogue order', async () => {
    const store = await seed(['v1', 'v2', 'v3', 'v4']);

    const result = await harvestDetails(store, '@example', { maxVideos: 2 });

    expect(detailed(store)).toEqual(['v1', 'v2']);
    expect(result).toMatchObject({ attempted: 2, stored: 2, remaining: 2, failures: [] });
  });

  it('never reads a video twice, so a second run continues where the first stopped', async () => {
    const store = await seed(['v1', 'v2', 'v3']);

    await harvestDetails(store, '@example', { maxVideos: 2 });
    vi.mocked(fetchVideoStatsRow).mockClear();
    const second = await harvestDetails(store, '@example', { maxVideos: 2 });

    expect(vi.mocked(fetchVideoStatsRow).mock.calls.map(([id]) => id)).toEqual(['v3']);
    expect(second).toMatchObject({ stored: 1, remaining: 0 });
    expect(detailed(store)).toEqual(['v1', 'v2', 'v3']);
  });

  it('proves completeness only against a catalogue that is itself complete', async () => {
    const store = await seed(['v1', 'v2']);

    const result = await harvestDetails(store, '@example', { maxVideos: 10 });

    expect(result.coverage).toMatchObject({
      scope: 'video-details',
      targetId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
      complete: true,
      have: 2,
      expected: 2,
      expectedSource: 'store:catalog',
    });
    expect(readReceipt(store, 'video-details', 'UCaaaaaaaaaaaaaaaaaaaaaa')?.complete).toBe(true);
  });

  it('does not claim completeness when the catalogue it is measured against is partial', async () => {
    const store = await seed(['v1', 'v2'], { catalogComplete: false });

    const result = await harvestDetails(store, '@example', { maxVideos: 10 });

    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.expected).toBeUndefined();
    expect(result.coverage.have).toBe(2);
  });

  it('says it was the cap that stopped it, and how to continue', async () => {
    const store = await seed(['v1', 'v2', 'v3']);

    const { coverage } = await harvestDetails(store, '@example', { maxVideos: 2 });

    expect(coverage).toMatchObject({
      complete: false,
      reason: 'CAP_REACHED',
      limitApplied: 2,
      resumeToken: 'details:UCaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('keeps what it read when YouTube starts refusing, and reports why it stopped', async () => {
    const store = await seed(Array.from({ length: 12 }, (_, index) => `v${String(index + 1)}`));
    vi.mocked(fetchVideoStatsRow).mockImplementation((id) =>
      id === 'v5'
        ? Promise.reject(new YouTubeError('BOT_CHECK', 'Sign in to confirm you are not a bot.'))
        : Promise.resolve({ id })
    );

    const result = await harvestDetails(store, '@example', { maxVideos: 10 });

    expect(result.coverage).toMatchObject({ complete: false, reason: 'SOURCE_REFUSED' });
    expect(result.stoppedBecause).toBe('BOT_CHECK');
    // Whatever came back before the refusal is kept, never thrown away with the run.
    expect(detailed(store).length).toBeGreaterThan(0);
    expect(detailed(store)).not.toContain('v5');
    // Reads already in flight alongside the refused one finish; nothing after them is tried.
    expect(detailed(store)).not.toContain('v9');
    expect(detailed(store)).not.toContain('v12');
  });

  it('records a private video as unreadable, carries on, and never retries it', async () => {
    const store = await seed(['v1', 'v2', 'v3']);
    vi.mocked(fetchVideoStatsRow).mockImplementation((id) =>
      Promise.resolve(id === 'v1' ? { id, availability: 'private' } : { id })
    );

    const first = await harvestDetails(store, '@example', { maxVideos: 10 });
    expect(first.failures).toEqual([{ videoId: 'v1', code: 'PRIVATE' }]);
    expect(detailed(store)).toEqual(['v2', 'v3']);
    // It is not "detailed": nothing was read. It is marked so it does not starve the rest.
    expect(
      store.prepare("SELECT availability FROM video WHERE video_id = 'v1'").get()
    ).toMatchObject({ availability: 'private' });

    vi.mocked(fetchVideoStatsRow).mockClear();
    await harvestDetails(store, '@example', { maxVideos: 10 });
    expect(fetchVideoStatsRow).not.toHaveBeenCalled();
  });

  it('stays incomplete while any video cannot be read, and names how many', async () => {
    const store = await seed(['v1', 'v2']);
    vi.mocked(fetchVideoStatsRow).mockImplementation((id) =>
      Promise.resolve(id === 'v1' ? { id, availability: 'private' } : { id })
    );

    const { coverage } = await harvestDetails(store, '@example', { maxVideos: 10 });

    expect(coverage).toMatchObject({
      complete: false,
      reason: 'PARTIAL_ERROR',
      have: 1,
      expected: 2,
    });
    expect(coverage.note).toContain('1 video');
  });

  it('asks for a refused video as a row, so one private video is not mistaken for a session problem', async () => {
    const store = await seed(['v1']);

    await harvestDetails(store, '@example', { maxVideos: 10 });

    expect(fetchVideoStatsRow).toHaveBeenCalledWith('v1', { tolerateRefusal: true });
  });

  it.each([
    ['subscriber_only', 'MEMBERS_ONLY'],
    ['premium_only', 'PREMIUM_ONLY'],
    ['needs_auth', 'AGE_GATED'],
  ])('reads availability %s as %s, and does not stop for it', async (availability, code) => {
    const store = await seed(['v1', 'v2']);
    vi.mocked(fetchVideoStatsRow).mockImplementation((id) =>
      Promise.resolve(id === 'v1' ? { id, availability } : { id })
    );

    const result = await harvestDetails(store, '@example', { maxVideos: 10 });

    expect(result.failures).toEqual([{ videoId: 'v1', code }]);
    expect(result.stoppedBecause).toBeUndefined();
    expect(detailed(store)).toEqual(['v2']);
  });

  it('still stops when the session itself needs signing in, which every video would hit', async () => {
    const store = await seed(Array.from({ length: 12 }, (_, index) => `v${String(index + 1)}`));
    vi.mocked(fetchVideoStatsRow).mockRejectedValue(
      new YouTubeError('LOGIN_REQUIRED', 'Sign in to continue.')
    );

    const result = await harvestDetails(store, '@example', { maxVideos: 10 });

    expect(result.stoppedBecause).toBe('LOGIN_REQUIRED');
    expect(result.attempted).toBeLessThan(10);
  });

  it('keeps going past an ordinary failure, which costs only that video', async () => {
    const store = await seed(['v1', 'v2']);
    vi.mocked(fetchVideoStatsRow).mockImplementation((id) =>
      id === 'v1' ? Promise.reject(new Error('socket hang up')) : Promise.resolve({ id })
    );

    const result = await harvestDetails(store, '@example', { maxVideos: 10 });

    expect(result.failures).toEqual([{ videoId: 'v1', code: 'YTDLP_FAILED' }]);
    expect(detailed(store)).toEqual(['v2']);
  });

  it('does not let a video that keeps failing hold the queue, and retries it on request', async () => {
    const store = await seed(['v1', 'v2', 'v3']);
    vi.mocked(fetchVideoStatsRow).mockImplementation((id) =>
      id === 'v1'
        ? Promise.reject(new YouTubeError('LIVE_NOT_ENDED', 'This live stream has not ended.'))
        : Promise.resolve({ id })
    );

    await harvestDetails(store, '@example', { maxVideos: 1 });
    // v1 failed, so the next run takes v2 instead of trying v1 first again.
    await harvestDetails(store, '@example', { maxVideos: 1 });
    expect(detailed(store)).toEqual(['v2']);
    expect(
      store.prepare("SELECT availability FROM video WHERE video_id = 'v1'").get()
    ).toMatchObject({ availability: 'read_failed' });

    // Asked to, it tries the failed video again.
    vi.mocked(fetchVideoStatsRow).mockImplementation((id) => Promise.resolve({ id }));
    await harvestDetails(store, '@example', { maxVideos: 10, retryUnreadable: true });
    expect(detailed(store)).toEqual(['v1', 'v2', 'v3']);
  });

  it('does not mark a video for a refusal that every video would hit', async () => {
    const store = await seed(['v1', 'v2']);
    vi.mocked(fetchVideoStatsRow).mockRejectedValue(
      new YouTubeError('BOT_CHECK', 'Sign in to confirm.')
    );

    await harvestDetails(store, '@example', { maxVideos: 10 });

    expect(
      store.prepare('SELECT COUNT(*) AS n FROM video WHERE availability IS NOT NULL').get()
    ).toEqual({ n: 0 });
  });

  it('refuses a channel that has not been catalogued, and says what to do first', async () => {
    const store = await getStore();

    await expect(harvestDetails(store, '@example', { maxVideos: 10 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      nextStep: expect.stringContaining('harvest_channel'),
    });
    expect(fetchVideoStatsRow).not.toHaveBeenCalled();
  });
});
