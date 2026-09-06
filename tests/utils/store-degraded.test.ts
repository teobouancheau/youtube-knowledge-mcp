import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

vi.mock('../../src/utils/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/store.js')>();
  return { ...actual, getStore: vi.fn() };
});

import { getStore } from '../../src/utils/store.js';
import { readStoreHealth } from '../../src/utils/store-health.js';
import { YouTubeError } from '../../src/utils/errors.js';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-degraded-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('readStoreHealth when the store cannot be opened', () => {
  it('reports the condition instead of failing the whole health check', async () => {
    // check_health exists to diagnose yt-dlp and ffmpeg. A store that will not
    // open must not take that diagnosis down with it.
    vi.mocked(getStore).mockRejectedValue(
      new YouTubeError('STORE_UNAVAILABLE', 'This Node build has no node:sqlite.')
    );

    const health = await readStoreHealth();

    expect(health.enabled).toBe(false);
    expect(health.error).toContain('node:sqlite');
    expect(health.integrity).toBe('unchecked');
    expect(health.comments).toBe(0);
  });

  it('describes a non-Error rejection rather than printing [object Object]', async () => {
    vi.mocked(getStore).mockRejectedValue('disk on fire');

    expect((await readStoreHealth()).error).toBe('disk on fire');
  });
});
