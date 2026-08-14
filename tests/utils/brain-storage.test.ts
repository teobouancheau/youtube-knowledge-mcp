import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainChunk, BrainManifest } from '../../src/brain-schemas.js';
import { readChunks, searchBrain, writeChunks } from '../../src/utils/brain-index.js';
import { brainDir, brainsDir, lockPath } from '../../src/utils/brain-paths.js';
import { LOCK_STALE_MS, withBuildLock } from '../../src/utils/brain-lock.js';
import {
  BRAIN_MANIFEST_VERSION,
  deleteBrain,
  hasProfile,
  listManifests,
  readManifest,
  readProfile,
  requireManifest,
  writeManifest,
  writeProfile,
} from '../../src/utils/brain-storage.js';
import { YouTubeError } from '../../src/utils/errors.js';
import { writeJsonAtomic } from '../../src/utils/json-file.js';

/**
 * Against a real temporary filesystem. The failures worth catching here — a
 * half-written manifest, a lock nobody released, an index disagreeing with the
 * passages beside it — are exactly the ones a mocked `fs` assumes away.
 */

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});

const CHANNEL_ID = 'UCXuqSBlHAE6Xw-yeJA0Tunw';
const OTHER_CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';

function manifest(overrides: Partial<BrainManifest> = {}): BrainManifest {
  return {
    version: BRAIN_MANIFEST_VERSION,
    channel: {
      name: 'Linus Tech Tips',
      channelId: CHANNEL_ID,
      handle: '@LinusTechTips',
      subscriberCount: 1000,
      channelUrl: `https://www.youtube.com/channel/${CHANNEL_ID}`,
      description: '',
    },
    language: 'en',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    videos: {},
    stats: {
      videoCount: 0,
      excludedCount: 0,
      indexedCount: 0,
      noCaptionsCount: 0,
      failedCount: 0,
      pendingCount: 0,
      chunkCount: 0,
      totalWords: 0,
      medianWordsPerMinute: 0,
      uploadsPerMonth: [],
      recurringPhrases: [],
    },
    ...overrides,
  };
}

function chunk(text: string, startSeconds: number, ordinal: number): BrainChunk {
  return {
    id: `vid1:${ordinal}`,
    videoId: 'vid1',
    title: 'Cooling a server rack',
    startSeconds,
    endSeconds: startSeconds + 30,
    text,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ytk-brain-'));
  process.env.TEST_HOME = home;
});

afterEach(async () => {
  delete process.env.TEST_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('brain paths', () => {
  it('refuses a channel id that could climb out of the brains directory', () => {
    expect(() => brainDir('../../../etc')).toThrow(YouTubeError);
  });
});

describe('manifest', () => {
  it('round trips', async () => {
    await writeManifest(manifest());

    expect(await readManifest(CHANNEL_ID)).toEqual(manifest());
  });

  it('reports no brain rather than an empty one', async () => {
    expect(await readManifest(CHANNEL_ID)).toBeUndefined();
    await expect(requireManifest(CHANNEL_ID)).rejects.toThrow(YouTubeError);
  });

  it('names the tool that would create the brain', async () => {
    await expect(requireManifest(CHANNEL_ID)).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    );
  });

  it('drops a corrupt video entry rather than losing the brain', async () => {
    const withBadEntry = manifest({
      videos: {
        good: {
          videoId: 'good',
          title: 'Fine',
          url: 'https://www.youtube.com/watch?v=good',
          uploadDate: '2025-01-01',
          durationSeconds: 60,
          state: 'indexed',
          chunkCount: 1,
          wordCount: 10,
        },
      },
    });

    await writeManifest(withBadEntry);
    const path = join(brainDir(CHANNEL_ID), 'manifest.json');
    const raw = JSON.parse(await readManifestRaw(path)) as { videos: Record<string, unknown> };
    raw.videos.broken = { videoId: 'broken' };
    await writeJsonAtomic(path, raw);

    const read = await readManifest(CHANNEL_ID);

    expect(Object.keys(read?.videos ?? {})).toEqual(['good']);
  });

  it('survives a truncated manifest', async () => {
    await mkdir(brainDir(CHANNEL_ID), { recursive: true });
    await writeFile(join(brainDir(CHANNEL_ID), 'manifest.json'), '{"version": 1, "chan', 'utf-8');

    expect(await readManifest(CHANNEL_ID)).toBeUndefined();
  });
});

describe('listManifests', () => {
  it('is empty before anything is built', async () => {
    expect(await listManifests()).toEqual([]);
  });

  it('returns the most recently updated first and ignores stray directories', async () => {
    await writeManifest(manifest({ updatedAt: '2025-01-01T00:00:00.000Z' }));
    await writeManifest(
      manifest({
        channel: { ...manifest().channel, channelId: OTHER_CHANNEL_ID },
        updatedAt: '2025-06-01T00:00:00.000Z',
      })
    );
    await mkdir(join(brainsDir(), 'not-a-channel'), { recursive: true });

    const found = await listManifests();

    expect(found.map((entry) => entry.channel.channelId)).toEqual([OTHER_CHANNEL_ID, CHANNEL_ID]);
  });
});

describe('deleteBrain', () => {
  it('reports whether there was anything to delete', async () => {
    expect(await deleteBrain(CHANNEL_ID)).toBe(false);

    await writeManifest(manifest());

    expect(await deleteBrain(CHANNEL_ID)).toBe(true);
    expect(await readManifest(CHANNEL_ID)).toBeUndefined();
  });

  it('is safe to call twice', async () => {
    await writeManifest(manifest());

    expect(await deleteBrain(CHANNEL_ID)).toBe(true);
    expect(await deleteBrain(CHANNEL_ID)).toBe(false);
  });
});

describe('profile', () => {
  it('round trips and reports its presence', async () => {
    expect(hasProfile(CHANNEL_ID)).toBe(false);

    await writeProfile(CHANNEL_ID, '# Voice\n\nSpeaks in lists.');

    expect(hasProfile(CHANNEL_ID)).toBe(true);
    expect(await readProfile(CHANNEL_ID)).toContain('Speaks in lists');
  });

  it('reads back nothing when none was written', async () => {
    expect(await readProfile(CHANNEL_ID)).toBeUndefined();
  });
});

describe('withBuildLock', () => {
  it('releases the lock when the build succeeds', async () => {
    await withBuildLock(CHANNEL_ID, () => Promise.resolve('done'));

    await expect(withBuildLock(CHANNEL_ID, () => Promise.resolve('again'))).resolves.toBe('again');
  });

  it('releases the lock when the build throws', async () => {
    await expect(
      withBuildLock(CHANNEL_ID, () => Promise.reject(new Error('cancelled')))
    ).rejects.toThrow('cancelled');

    await expect(withBuildLock(CHANNEL_ID, () => Promise.resolve('after'))).resolves.toBe('after');
  });

  it('refuses a second build while one is running', async () => {
    let release: () => void = () => undefined;
    let announceStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });

    const running = withBuildLock(
      CHANNEL_ID,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          announceStarted();
        })
    );

    // Waiting for the build to actually begin, rather than assuming the first
    // call wins the race: both are async, and either could reach the lock first.
    await started;

    await expect(withBuildLock(CHANNEL_ID, () => Promise.resolve('second'))).rejects.toThrow(
      YouTubeError
    );

    release();
    await running;
  });

  it('lets exactly one of two simultaneous builds through', async () => {
    const outcomes = await Promise.allSettled([
      withBuildLock(CHANNEL_ID, () => Promise.resolve('a')),
      withBuildLock(CHANNEL_ID, () => Promise.resolve('b')),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  });

  it('breaks a lock left by a process that is gone', async () => {
    await mkdir(brainDir(CHANNEL_ID), { recursive: true });
    await writeJsonAtomic(lockPath(CHANNEL_ID), {
      // Above the maximum pid on every platform this runs on, so nothing owns it.
      pid: 4_194_305,
      startedAt: new Date().toISOString(),
    });

    await expect(withBuildLock(CHANNEL_ID, () => Promise.resolve('taken'))).resolves.toBe('taken');
  });

  it('breaks a lock older than any real build', async () => {
    await mkdir(brainDir(CHANNEL_ID), { recursive: true });
    await writeJsonAtomic(lockPath(CHANNEL_ID), {
      pid: process.pid,
      startedAt: new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString(),
    });

    await expect(withBuildLock(CHANNEL_ID, () => Promise.resolve('taken'))).resolves.toBe('taken');
  });
});

describe('passages', () => {
  const passages = [
    chunk('the radiator sits above the rack and pulls heat away', 0, 0),
    chunk('we talk about noise levels and fan curves next', 30, 1),
  ];

  it('round trips', async () => {
    await writeChunks(CHANNEL_ID, passages);

    expect(await readChunks(CHANNEL_ID)).toEqual(passages);
  });

  it('is empty for a channel with no brain', async () => {
    expect(await readChunks(CHANNEL_ID)).toEqual([]);
    expect((await searchBrain(CHANNEL_ID, 'radiator', 5)).passages).toEqual([]);
  });

  it('returns a passage with the link that opens it', async () => {
    await writeChunks(CHANNEL_ID, passages);

    const { passages: found } = await searchBrain(CHANNEL_ID, 'radiator', 5);
    const [hit] = found;

    expect(hit).toMatchObject({
      videoId: 'vid1',
      startSeconds: 0,
      startFormatted: '0:00',
      url: 'https://www.youtube.com/watch?v=vid1&t=0s',
    });
    expect(hit?.text).toContain('radiator');
  });

  it('ranks the passage that answers the query first', async () => {
    await writeChunks(CHANNEL_ID, passages);

    const { passages: ranked } = await searchBrain(CHANNEL_ID, 'fan curves noise', 5);

    expect(ranked[0]?.startSeconds).toBe(30);
  });

  it('sees passages added after an earlier search', async () => {
    await writeChunks(CHANNEL_ID, passages.slice(0, 1));
    expect((await searchBrain(CHANNEL_ID, 'fan curves', 5)).passages).toEqual([]);

    await writeChunks(CHANNEL_ID, passages);

    expect((await searchBrain(CHANNEL_ID, 'fan curves', 5)).passages).toHaveLength(1);
  });
});

async function readManifestRaw(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf-8');
}
