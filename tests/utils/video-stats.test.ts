import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

vi.mock('../../src/utils/ytdlp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/ytdlp.js')>();
  return { ...actual, runYtDlp: vi.fn() };
});

import { runYtDlp } from '../../src/utils/ytdlp.js';
import {
  CATALOG_DESCRIPTION_PREVIEW_CHARS,
  MAX_DETAIL_JSON_BYTES,
  STRIPPED_KEYS,
  getVideoStats,
  stripForStorage,
} from '../../src/utils/video-stats.js';
import { readVideoStats } from '../../src/utils/video-stats-cache.js';

const ROW = {
  id: 'dQw4w9WgXcQ',
  title: 'A video',
  channel: 'A channel',
  channel_id: 'UCch',
  upload_date: '20260101',
  duration: 212,
  view_count: 100,
  like_count: 9,
  comment_count: 2_400_000,
  categories: ['Music'],
  tags: ['a', 'b'],
  chapters: [{ title: 'Intro', start_time: 0, end_time: 10 }],
  heatmap: [{ start_time: 0, end_time: 2, value: 0.5 }],
  automatic_captions: { en: [{ url: 'x' }], fr: [{ url: 'y' }] },
  subtitles: { en: [{ url: 'z' }] },
  description: 'hello',
  thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-stats-'));
  vi.mocked(runYtDlp).mockResolvedValue(JSON.stringify(ROW));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('getVideoStats', () => {
  it('serves info, chapters, captions and the heatmap from one read', async () => {
    const stats = await getVideoStats('dQw4w9WgXcQ');

    expect(stats).toMatchObject({
      title: 'A video',
      durationSeconds: 212,
      commentCount: 2_400_000,
      categories: ['Music'],
      hasHeatmap: true,
    });
    expect(stats.chapters).toHaveLength(1);
    expect(vi.mocked(runYtDlp)).toHaveBeenCalledTimes(1);
  });

  it('keeps caption language tags, never the URL arrays', async () => {
    // Measured: automatic_captions is 72% of a 637KB payload, and every URL in
    // it expires. The inventory is what a caller actually asks about.
    const stats = await getVideoStats('dQw4w9WgXcQ');

    expect(stats.captions).toEqual({ manual: ['en'], automatic: ['en', 'fr'] });
    // The watch URL is a field of its own; what must not survive is the
    // caption payload the language tags were taken from.
    expect(JSON.stringify(stats.captions)).not.toContain('http');
  });

  it('reports the real comment count, because this read has no --write-comments', async () => {
    expect((await getVideoStats('dQw4w9WgXcQ')).commentCount).toBe(2_400_000);
  });
});

describe('a sparse row', () => {
  it('fills in defaults rather than carrying nulls through', async () => {
    vi.mocked(runYtDlp).mockResolvedValue(JSON.stringify({ id: 'dQw4w9WgXcQ' }));
    const stats = await getVideoStats('dQw4w9WgXcQ');

    expect(stats).toMatchObject({
      title: 'Unknown',
      channel: 'Unknown',
      uploadDate: '',
      durationSeconds: 0,
      categories: [],
      tags: [],
      ageLimit: 0,
      wasLive: false,
      chapters: [],
      captions: { manual: [], automatic: [] },
      hasHeatmap: false,
      descriptionChars: 0,
    });
    expect(stats.viewCount).toBeUndefined();
    expect(stats.heatmap).toBeUndefined();
    expect(stats.channelId).toBeUndefined();
  });

  it('reports an empty heatmap as absent rather than present', async () => {
    vi.mocked(runYtDlp).mockResolvedValue(JSON.stringify({ id: 'dQw4w9WgXcQ', heatmap: [] }));
    expect((await getVideoStats('dQw4w9WgXcQ')).hasHeatmap).toBe(false);
  });

  it('refuses a video YouTube says is private', async () => {
    vi.mocked(runYtDlp).mockResolvedValue(
      JSON.stringify({ id: 'dQw4w9WgXcQ', availability: 'private' })
    );

    await expect(getVideoStats('dQw4w9WgXcQ')).rejects.toMatchObject({ code: 'PRIVATE' });
  });
});

describe('getVideoDetails as a projection', () => {
  it('shares the one read rather than spawning its own', async () => {
    const { getVideoDetails } = await import('../../src/utils/youtube-video.js');

    const details = await getVideoDetails('dQw4w9WgXcQ');
    await getVideoDetails('dQw4w9WgXcQ');

    expect(details.chapters[0]).toMatchObject({ title: 'Intro', startTimeFormatted: '0:00' });
    expect(details.commentCount).toBe(2_400_000);
    // Two callers, one request: this is where the halving actually lands.
    expect(vi.mocked(runYtDlp)).toHaveBeenCalledTimes(1);
  });
});

describe('stripForStorage', () => {
  it('drops every bulk key', () => {
    const stripped = stripForStorage({ ...ROW });

    for (const key of STRIPPED_KEYS) expect(stripped).not.toHaveProperty(key);
    expect(stripped).toHaveProperty('title');
  });

  it('keeps a stored record under the size a catalogue can afford', () => {
    const huge = {
      ...ROW,
      automatic_captions: Object.fromEntries(
        Array.from({ length: 160 }, (_, i) => [`lang${String(i)}`, [{ url: 'x'.repeat(2_000) }]])
      ),
      formats: Array.from({ length: 40 }, () => ({ url: 'y'.repeat(3_000) })),
    };

    const stripped = stripForStorage(huge);
    expect(Buffer.byteLength(JSON.stringify(stripped))).toBeLessThan(MAX_DETAIL_JSON_BYTES);
  });

  it('truncates a long description and says so', () => {
    const stripped = stripForStorage({ ...ROW, description: 'x'.repeat(5_000) });

    expect(stripped.description).toHaveLength(CATALOG_DESCRIPTION_PREVIEW_CHARS);
    expect(stripped.description_truncated).toBe(true);
  });

  it('leaves a short description alone', () => {
    expect(stripForStorage({ ...ROW }).description_truncated).toBeUndefined();
  });
});

describe('the stats cache', () => {
  it('reads YouTube once and disk thereafter', async () => {
    const first = await readVideoStats('dQw4w9WgXcQ');
    const second = await readVideoStats('dQw4w9WgXcQ');

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    // The whole point: two callers wanting the same video cost one request.
    expect(vi.mocked(runYtDlp)).toHaveBeenCalledTimes(1);
  });

  it('refetches when asked', async () => {
    await readVideoStats('dQw4w9WgXcQ');
    const refreshed = await readVideoStats('dQw4w9WgXcQ', { refresh: true });

    expect(refreshed.cached).toBe(false);
    expect(vi.mocked(runYtDlp)).toHaveBeenCalledTimes(2);
  });

  it('refetches once the entry is stale', async () => {
    const now = Date.now();
    await readVideoStats('dQw4w9WgXcQ', {}, now);
    const later = await readVideoStats('dQw4w9WgXcQ', {}, now + 2 * 86_400_000);

    expect(later.cached).toBe(false);
  });

  it('shards so no directory grows to a hundred thousand entries', async () => {
    await readVideoStats('dQw4w9WgXcQ');
    expect(existsSync(join(home, '.youtube-knowledge', 'stats', 'dQ', 'dQw4w9WgXcQ.json'))).toBe(
      true
    );
  });

  it('refetches rather than half-trusting an unreadable entry', async () => {
    await readVideoStats('dQw4w9WgXcQ');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(home, '.youtube-knowledge', 'stats', 'dQ', 'dQw4w9WgXcQ.json'),
      '{ not json'
    );

    expect((await readVideoStats('dQw4w9WgXcQ')).cached).toBe(false);
  });
});
