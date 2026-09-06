import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

import { withChannelHarvestLock, withVideoHarvestLock } from '../../src/utils/harvest-lock.js';
import { channelHarvestLockPath } from '../../src/utils/store-paths.js';
import { YouTubeError } from '../../src/utils/errors.js';

const CHANNEL = 'UCK8sQmJBp8GCxrOtXWBpyEA';
const VIDEO = 'rPq7ITrWFvY';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-hlock-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('harvest locks', () => {
  it('runs the work and releases the lock', async () => {
    expect(await withChannelHarvestLock(CHANNEL, () => Promise.resolve('done'))).toBe('done');
    expect(existsSync(channelHarvestLockPath(CHANNEL))).toBe(false);
  });

  it('refuses a second harvest of the same channel while one is running', async () => {
    // WAL keeps the rows consistent; this is about the requests. Two harvests
    // would each spawn yt-dlp and double the rate at the thing that throttles.
    await withChannelHarvestLock(CHANNEL, async () => {
      const error: unknown = await withChannelHarvestLock(CHANNEL, () =>
        Promise.resolve('should not run')
      ).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(YouTubeError);
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
      expect((error as YouTubeError).message).toContain('already running');
    });
  });

  it('locks channels and videos independently', async () => {
    await withChannelHarvestLock(CHANNEL, async () => {
      expect(await withVideoHarvestLock(VIDEO, () => Promise.resolve('ok'))).toBe('ok');
    });
  });

  it('refuses a second harvest of the same video while one is running', async () => {
    await withVideoHarvestLock(VIDEO, async () => {
      const error: unknown = await withVideoHarvestLock(VIDEO, () =>
        Promise.resolve('should not run')
      ).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(YouTubeError);
      expect((error as YouTubeError).message).toContain(`video ${VIDEO} is already running`);
    });
  });

  it('releases the lock when the work throws', async () => {
    await expect(
      withVideoHarvestLock(VIDEO, () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');

    expect(await withVideoHarvestLock(VIDEO, () => Promise.resolve('free'))).toBe('free');
  });
});
