import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});

import type { ThumbnailEntry, ThumbnailManifest } from '../../src/thumbnail-schemas.js';
import {
  channelImageFile,
  computeThumbnailStats,
  deleteThumbnails,
  ensureThumbnailDirs,
  entryPath,
  isIntact,
  listThumbnailManifests,
  readThumbnailManifest,
  requireThumbnailManifest,
  resolveThumbnails,
  writeThumbnailManifest,
} from '../../src/utils/thumbnail-store.js';
import {
  thumbnailDir,
  thumbnailsDir,
  videoThumbnailPath,
} from '../../src/utils/thumbnail-paths.js';

const CHANNEL_ID = 'UCsBjURrPoezykLs9EqgamOA';
const OTHER_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';

function manifest(
  channelId = CHANNEL_ID,
  overrides: Partial<ThumbnailManifest> = {}
): ThumbnailManifest {
  return {
    version: 1,
    channel: {
      name: 'Fireship',
      channelId,
      handle: '@Fireship',
      subscriberCount: 1,
      channelUrl: `https://www.youtube.com/channel/${channelId}`,
      description: '',
    },
    tabs: ['videos'],
    quality: 'best',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    videos: {},
    stats: computeThumbnailStats([]),
    ...overrides,
  };
}

const saved: ThumbnailEntry = {
  videoId: 'dQw4w9WgXcQ',
  title: 'A',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  tab: 'videos',
  isShort: false,
  durationSeconds: 10,
  state: 'saved',
  format: 'jpg',
  bytes: 3,
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'thumbnail-store-'));
  process.env.TEST_HOME = home;
});

afterEach(async () => {
  delete process.env.TEST_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('thumbnail manifests', () => {
  it('round-trips a manifest and creates the tab directories', async () => {
    await ensureThumbnailDirs(CHANNEL_ID, ['videos', 'shorts']);
    await writeThumbnailManifest(manifest());

    expect(existsSync(join(thumbnailDir(CHANNEL_ID), 'shorts'))).toBe(true);
    expect(existsSync(join(thumbnailDir(CHANNEL_ID), 'channel'))).toBe(true);
    expect(await readThumbnailManifest(CHANNEL_ID)).toMatchObject({
      channel: { name: 'Fireship' },
    });
  });

  it('reports nothing before anything was fetched, and names the tool that fetches', async () => {
    expect(await readThumbnailManifest(CHANNEL_ID)).toBeUndefined();
    await expect(requireThumbnailManifest(CHANNEL_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(resolveThumbnails('@Fireship')).rejects.toMatchObject({
      nextStep: expect.stringContaining('fetch_channel_thumbnails') as string,
    });
  });

  it('returns the manifest when one exists', async () => {
    await writeThumbnailManifest(manifest());
    expect((await requireThumbnailManifest(CHANNEL_ID)).channel.channelId).toBe(CHANNEL_ID);
  });

  it('names a set by its channel name when it has no handle', async () => {
    const nameless = manifest();
    nameless.channel.handle = '';
    await writeThumbnailManifest(nameless);

    await expect(resolveThumbnails('@nobody')).rejects.toMatchObject({
      nextStep: expect.stringContaining('Fireship') as string,
    });
  });

  it('lists every set newest first and skips what is not one', async () => {
    await writeThumbnailManifest(manifest(CHANNEL_ID, { updatedAt: '2026-01-01T00:00:00.000Z' }));
    await writeThumbnailManifest(manifest(OTHER_ID, { updatedAt: '2026-02-01T00:00:00.000Z' }));
    await mkdir(join(thumbnailsDir(), 'not-a-channel'));
    await writeFile(join(thumbnailsDir(), 'stray.txt'), '');

    const listed = await listThumbnailManifests();
    expect(listed.map((m) => m.channel.channelId)).toEqual([OTHER_ID, CHANNEL_ID]);
  });

  it('lists nothing when the directory does not exist yet', async () => {
    expect(await listThumbnailManifests()).toEqual([]);
  });

  it('resolves a set by handle and names the alternatives when none matches', async () => {
    await writeThumbnailManifest(manifest());

    expect((await resolveThumbnails('fireship')).channel.channelId).toBe(CHANNEL_ID);
    await expect(resolveThumbnails('@nobody')).rejects.toMatchObject({
      nextStep: expect.stringContaining('@Fireship') as string,
    });
  });

  it('refuses to guess between two sets that answer to the same name', async () => {
    await writeThumbnailManifest(manifest(CHANNEL_ID));
    await writeThumbnailManifest(manifest(OTHER_ID));

    await expect(resolveThumbnails('Fireship')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('deletes a set and reports whether it existed', async () => {
    await writeThumbnailManifest(manifest());
    expect(await deleteThumbnails(CHANNEL_ID)).toBe(true);
    expect(await deleteThumbnails(CHANNEL_ID)).toBe(false);
    expect(existsSync(thumbnailDir(CHANNEL_ID))).toBe(false);
  });
});

describe('entry paths and integrity', () => {
  it('recomputes a saved entry path from its validated parts', () => {
    expect(entryPath(CHANNEL_ID, saved)).toBe(
      videoThumbnailPath(CHANNEL_ID, 'videos', 'dQw4w9WgXcQ', 'jpg')
    );
    expect(entryPath(CHANNEL_ID, { ...saved, state: 'pending' })).toBeUndefined();
    expect(entryPath(CHANNEL_ID, { ...saved, format: undefined })).toBeUndefined();
  });

  it('recomputes a channel image path the same way', () => {
    expect(
      channelImageFile(CHANNEL_ID, { kind: 'avatar', state: 'saved', format: 'png' })
    ).toContain(join('channel', 'avatar.png'));
    expect(channelImageFile(CHANNEL_ID, { kind: 'avatar', state: 'failed' })).toBeUndefined();
  });

  it('calls a file intact only when it exists at the recorded size', async () => {
    await ensureThumbnailDirs(CHANNEL_ID, ['videos']);
    const path = videoThumbnailPath(CHANNEL_ID, 'videos', 'dQw4w9WgXcQ', 'jpg');
    await writeFile(path, 'abc');

    expect(await isIntact(path, 3)).toBe(true);
    expect(await isIntact(path, 4)).toBe(false);
    expect(await isIntact(join(home, 'missing'), 3)).toBe(false);
    expect(await isIntact(undefined, 3)).toBe(false);
  });
});

describe('computeThumbnailStats', () => {
  it('counts states, bytes and per-tab coverage', () => {
    const stats = computeThumbnailStats([
      saved,
      { ...saved, videoId: 'aaaaaaaaaa1', state: 'failed', bytes: undefined },
      { ...saved, videoId: 'aaaaaaaaaa2', state: 'pending', bytes: undefined },
      { ...saved, videoId: 'aaaaaaaaaa3', tab: 'shorts', bytes: 5 },
      { ...saved, videoId: 'aaaaaaaaaa4', tab: 'shorts', bytes: undefined },
    ]);

    expect(stats).toEqual({
      videoCount: 5,
      savedCount: 3,
      failedCount: 1,
      pendingCount: 1,
      totalBytes: 8,
      tabs: [
        { tab: 'videos', videoCount: 3, savedCount: 1 },
        { tab: 'shorts', videoCount: 2, savedCount: 2 },
      ],
    });
  });
});
