import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textOf, structuredOf } from '../helpers.js';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

vi.mock('../../src/utils/ytdlp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/ytdlp.js')>();
  return { ...actual, runYtDlp: vi.fn() };
});

vi.mock('../../src/utils/youtube-channel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/youtube-channel.js')>();
  return { ...actual, getChannelInfo: vi.fn() };
});

import { runYtDlp } from '../../src/utils/ytdlp.js';
import { getChannelInfo } from '../../src/utils/youtube-channel.js';
import { closeStore, getStore } from '../../src/utils/store.js';
import { harvestChannelHandler } from '../../src/tools/harvest-channel.js';
import { getCoverageHandler } from '../../src/tools/get-coverage.js';
import { YouTubeError } from '../../src/utils/errors.js';

const CHANNEL = {
  name: 'Example',
  channelId: 'UCK8sQmJBp8GCxrOtXWBpyEA',
  handle: '@example',
  subscriberCount: 100,
  channelUrl: 'https://www.youtube.com/@example',
  description: '',
};

function entries(ids: string[]): string {
  return ids
    .map((id) => JSON.stringify({ id, title: `Video ${id}`, duration: 60, view_count: 5 }))
    .join('\n');
}

/** Answers each tab, and says what yt-dlp says for a tab a channel lacks. */
function tabs(byTab: Partial<Record<string, string[]>>): void {
  vi.mocked(runYtDlp).mockImplementation((_args, options) => {
    const tab = (options.label ?? '').split(':')[1] ?? '';
    const ids = byTab[tab];
    if (ids === undefined) {
      return Promise.reject(
        new YouTubeError('YTDLP_FAILED', `@example: This channel does not have a ${tab} tab`)
      );
    }
    return Promise.resolve(entries(ids));
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-harvest-'));
  vi.mocked(getChannelInfo).mockResolvedValue(CHANNEL);
});

afterEach(() => {
  closeStore();
  rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('harvest_channel', () => {
  it('catalogues every tab and reports a complete receipt', async () => {
    tabs({ videos: ['a', 'b'], shorts: ['c'], streams: [], releases: [], podcasts: [] });

    const result = await harvestChannelHandler({ channel: '@example', maxVideos: 500 });
    const structured = structuredOf(result);

    expect(structured).toMatchObject({
      channelId: CHANNEL.channelId,
      videosSeen: 3,
      videosAdded: 3,
      coverage: { complete: true, reason: 'COMPLETE', expectedSource: 'source-exhausted' },
    });
    expect(textOf(result)).toContain('Coverage: 3 of 3 videos');
    expect(textOf(result)).toContain('COMPLETE');
  });

  it('treats a tab the channel does not have as complete, not as a failure', async () => {
    tabs({ videos: ['a'] });

    const structured = structuredOf(
      await harvestChannelHandler({ channel: '@example', maxVideos: 500 })
    );
    const tabResults = structured.tabs;

    expect(structured).toMatchObject({ coverage: { complete: true } });
    expect(JSON.stringify(tabResults)).not.toContain('"error"');
  });

  it('does not claim completeness when a tab actually failed', async () => {
    vi.mocked(runYtDlp).mockImplementation((_args, options) => {
      const tab = (options.label ?? '').split(':')[1] ?? '';
      if (tab === 'videos') return Promise.resolve(entries(['a']));
      if (tab === 'shorts') return Promise.reject(new YouTubeError('RATE_LIMITED', 'throttled'));
      return Promise.reject(new YouTubeError('YTDLP_FAILED', `does not have a ${tab} tab`));
    });

    const result = await harvestChannelHandler({ channel: '@example', maxVideos: 500 });

    expect(structuredOf(result)).toMatchObject({ coverage: { complete: false } });
    expect(textOf(result)).toContain('INCOMPLETE');
    expect(textOf(result)).toContain('Do not describe this as the full video list');
  });

  it('marks a capped catalogue incomplete', async () => {
    tabs({ videos: ['a', 'b', 'c'] });

    const structured = structuredOf(
      await harvestChannelHandler({ channel: '@example', maxVideos: 2 })
    );

    expect(structured).toMatchObject({
      videosSeen: 2,
      coverage: { complete: false, reason: 'CAP_REACHED', limitApplied: 2 },
    });
  });

  it('keeps the first tab as owner when a later tab lists the same video', async () => {
    tabs({ videos: ['a'], shorts: ['a'] });

    await harvestChannelHandler({ channel: '@example', maxVideos: 500 });
    const store = await getStore();
    const row = store.prepare('SELECT tab, also_in_tabs FROM video WHERE video_id = ?').get('a');

    expect(row?.tab).toBe('videos');
    expect(row?.also_in_tabs).toBe('["shorts"]');
  });

  it('re-running costs requests but never data', async () => {
    tabs({ videos: ['a', 'b'] });
    await harvestChannelHandler({ channel: '@example', maxVideos: 500 });
    const second = structuredOf(
      await harvestChannelHandler({ channel: '@example', maxVideos: 500 })
    );

    expect(second).toMatchObject({ videosSeen: 2, videosAdded: 0 });
  });
});

describe('get_coverage', () => {
  it('says plainly when everything in scope is provable', async () => {
    tabs({ videos: ['a'] });
    await harvestChannelHandler({ channel: '@example', maxVideos: 500 });

    const result = await getCoverageHandler({
      incompleteOnly: false,
      verify: true,
      limit: 50,
      offset: 0,
    });

    expect(structuredOf(result)).toMatchObject({
      anyIncomplete: false,
      summary: { incomplete: 0 },
    });
    expect(textOf(result)).toContain('provably complete');
  });

  it('warns against overclaiming while anything is incomplete', async () => {
    tabs({ videos: ['a', 'b', 'c'] });
    await harvestChannelHandler({ channel: '@example', maxVideos: 2 });

    const result = await getCoverageHandler({
      incompleteOnly: false,
      verify: true,
      limit: 50,
      offset: 0,
    });

    expect(structuredOf(result)).toMatchObject({ anyIncomplete: true });
    expect(textOf(result)).toContain('Do not describe this data as a full history');
  });

  it('reports an empty store without inventing coverage', async () => {
    const structured = structuredOf(
      await getCoverageHandler({ incompleteOnly: false, verify: true, limit: 50, offset: 0 })
    );

    expect(structured).toMatchObject({
      anyIncomplete: false,
      receipts: [],
      store: { channels: 0, videos: 0, comments: 0 },
    });
  });

  it('filters to incomplete receipts on request', async () => {
    tabs({ videos: ['a', 'b', 'c'] });
    await harvestChannelHandler({ channel: '@example', maxVideos: 2 });

    const all = structuredOf(
      await getCoverageHandler({ incompleteOnly: false, verify: true, limit: 50, offset: 0 })
    );
    const only = structuredOf(
      await getCoverageHandler({ incompleteOnly: true, verify: true, limit: 50, offset: 0 })
    );

    expect(JSON.stringify(all.receipts)).toContain('CAP_REACHED');
    expect(JSON.stringify(only.receipts)).toContain('CAP_REACHED');
  });

  it('restricts to one scope', async () => {
    tabs({ videos: ['a'] });
    await harvestChannelHandler({ channel: '@example', maxVideos: 500 });

    const comments = structuredOf(
      await getCoverageHandler({
        scope: 'video-comments',
        incompleteOnly: false,
        verify: true,
        limit: 50,
        offset: 0,
      })
    );

    expect(comments).toMatchObject({ receipts: [], total: 0 });
  });

  it('skips verification when asked, and then trusts the receipt', async () => {
    const store = await getStore();
    store.exec("INSERT INTO video(video_id) VALUES ('v1')");
    store
      .prepare(
        `INSERT INTO harvest_receipt (scope,target_id,state,reason,have,expected,expected_source,source,started_at,finished_at,attempts)
         VALUES ('video-comments','v1','complete','COMPLETE',99,99,'youtube:comment_count','t',1,1,0)`
      )
      .run();

    const unverified = structuredOf(
      await getCoverageHandler({ incompleteOnly: false, verify: false, limit: 50, offset: 0 })
    );

    expect(unverified).toMatchObject({ anyIncomplete: false, mismatches: [] });
  });

  it('counts a complete receipt that is past its re-check date as stale', async () => {
    const store = await getStore();
    const old = Date.now() - 30 * 86_400_000;
    store
      .prepare(
        `INSERT INTO harvest_receipt (scope,target_id,state,reason,have,expected,expected_source,source,started_at,finished_at,attempts)
         VALUES ('channel-catalog','UC1','complete','COMPLETE',1,1,'source-exhausted','t',?,?,0)`
      )
      .run(old, old);

    const structured = structuredOf(
      await getCoverageHandler({ incompleteOnly: false, verify: true, limit: 50, offset: 0 })
    );

    expect(structured).toMatchObject({ summary: { stale: 1 } });
  });

  it('downgrades a receipt that disagrees with the store', async () => {
    const store = await getStore();
    store.exec("INSERT INTO video(video_id) VALUES ('v1')");
    store
      .prepare(
        `INSERT INTO harvest_receipt (scope,target_id,state,reason,have,expected,expected_source,source,started_at,finished_at,attempts)
         VALUES ('video-comments','v1','complete','COMPLETE',99,99,'youtube:comment_count','t',1,1,0)`
      )
      .run();

    const result = await getCoverageHandler({
      incompleteOnly: false,
      verify: true,
      limit: 50,
      offset: 0,
    });
    const structured = structuredOf(result);

    // The store is the authority; a receipt claiming 99 comments over an empty
    // table loses its claim rather than being believed.
    expect(structured).toMatchObject({ anyIncomplete: true });
    expect(JSON.stringify(structured.mismatches)).toContain('"storeHave":0');
    expect(textOf(result)).toContain('disagreed with the store');
  });
});
