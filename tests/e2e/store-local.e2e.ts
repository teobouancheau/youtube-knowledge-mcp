import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeRow, installFakeYtDlp } from './fake-ytdlp.js';
import {
  callTool,
  callToolOk,
  removeHome,
  startStdioServer,
  type ServerHandle,
} from './harness.js';

/**
 * The harvested store, end to end: the built server, a real MCP client, the real store
 * on disk, and a stand-in for yt-dlp that serves a small channel.
 *
 * It proves what this server does with what YouTube says: catalogue it, read each video
 * once, notice what was published since, and take the data out with its receipts. It
 * does not prove YouTube says what the stand-in does.
 */

const CHANNEL_ID = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const VIDEOS = ['vvvvvvvvv01', 'vvvvvvvvv02', 'vvvvvvvvv03'];
const SHORT = 'vvvvvvvvv04';
const PRIVATE = 'vvvvvvvvv03';
const FRESH = 'vvvvvvvvv05';

const entry = (id: string): Record<string, unknown> => ({
  id,
  title: `Video ${id}`,
  duration: 60,
  view_count: 100,
});

let server: ServerHandle;
let tabsFile: string;
let tabs: Record<string, Record<string, unknown>[]>;

async function publish(): Promise<void> {
  await writeFile(tabsFile, JSON.stringify(tabs));
}

beforeAll(async () => {
  const work = join(tmpdir(), `ykm-store-${String(process.pid)}`);
  await mkdir(work, { recursive: true });

  const channel = join(work, 'channel.json');
  await writeFile(
    channel,
    JSON.stringify({
      channel: 'Example',
      channel_id: CHANNEL_ID,
      channel_url: `https://www.youtube.com/channel/${CHANNEL_ID}`,
      uploader_id: '@example',
      channel_follower_count: 10,
      description: 'A test channel',
      thumbnails: [],
    })
  );

  tabsFile = join(work, 'tabs.json');
  tabs = {
    videos: VIDEOS.map(entry),
    shorts: [entry(SHORT)],
    playlists: [
      { id: 'PLtest', title: 'A playlist', url: 'https://www.youtube.com/playlist?list=PLtest' },
    ],
  };
  await publish();

  const rows = join(work, 'rows.json');
  await writeFile(
    rows,
    JSON.stringify(
      Object.fromEntries(
        [...VIDEOS, SHORT].map((id) => [
          id,
          fakeRow(id, {
            channel_id: CHANNEL_ID,
            comment_count: 12,
            view_count: 100,
            categories: ['Education'],
            heatmap: [{ start_time: 0, end_time: 5, value: 0.9 }],
            ...(id === PRIVATE ? { availability: 'private' } : {}),
          }),
        ])
      )
    )
  );

  const shimDir = await installFakeYtDlp(work);
  server = await startStdioServer({
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      FAKE_ROWS: rows,
      FAKE_CHANNEL: channel,
      FAKE_TABS: tabsFile,
    },
  });
});

afterAll(async () => {
  await server.close();
  await removeHome(server.home);
});

// One story, in order: each step is the state the next one starts from.
describe('the harvested store, with a stand-in for yt-dlp', () => {
  it('check_new_uploads refuses a channel that has not been catalogued, and says what to do', async () => {
    const outcome = await callTool(server.client, 'check_new_uploads', { channel: '@example' });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('harvest_channel');
  });

  it('list_channel_playlists lists the channel’s playlists', async () => {
    const { structured } = await callToolOk(server.client, 'list_channel_playlists', {
      channel: '@example',
    });

    expect(structured).toMatchObject({
      channelId: CHANNEL_ID,
      playlists: [{ id: 'PLtest', title: 'A playlist' }],
    });
  });

  it('harvest_channel catalogues every tab, and a tab the channel lacks is not a gap', async () => {
    const { structured } = await callToolOk(server.client, 'harvest_channel', {
      channel: '@example',
    });

    expect(structured).toMatchObject({ channelId: CHANNEL_ID, videosSeen: 4, videosAdded: 4 });
    expect(structured.coverage).toMatchObject({ scope: 'channel-catalog', complete: true });
  });

  it('harvest_details reads each video once, keeps the private one as unreadable, and says so', async () => {
    const { structured } = await callToolOk(server.client, 'harvest_details', {
      channel: '@example',
      maxVideos: 10,
    });

    expect(structured).toMatchObject({
      attempted: 4,
      stored: 3,
      remaining: 0,
      failures: [{ videoId: PRIVATE, code: 'PRIVATE' }],
    });
    // Every readable video is held, but one cannot be: the receipt must not say whole.
    expect(structured.coverage).toMatchObject({
      scope: 'video-details',
      complete: false,
      reason: 'PARTIAL_ERROR',
      have: 3,
      expected: 4,
      expectedSource: 'store:catalog',
    });
  });

  it('a second harvest_details finds nothing left to read, and does not retry the private video', async () => {
    const { structured } = await callToolOk(server.client, 'harvest_details', {
      channel: '@example',
      maxVideos: 10,
    });

    expect(structured).toMatchObject({ attempted: 0, stored: 0, failures: [], remaining: 0 });
  });

  it('query_videos now reports the videos that were read as detailed', async () => {
    const { structured } = await callToolOk(server.client, 'query_videos', {
      channel: CHANNEL_ID,
      order: 'catalog',
    });

    const flags = (structured.videos as { videoId: string; detailed: boolean }[]).map(
      (video) => [video.videoId, video.detailed] as const
    );
    expect(flags).toEqual([
      ['vvvvvvvvv01', true],
      ['vvvvvvvvv02', true],
      ['vvvvvvvvv03', false],
      ['vvvvvvvvv04', true],
    ]);
  });

  it('check_new_uploads names an upload that appeared after the catalogue, and writes nothing', async () => {
    tabs.videos = [entry(FRESH), ...VIDEOS.map(entry)];
    await publish();

    const { structured } = await callToolOk(server.client, 'check_new_uploads', {
      channel: '@example',
    });

    expect(structured).toMatchObject({
      newCount: 1,
      newVideos: [{ videoId: FRESH, tab: 'videos' }],
      catalogComplete: true,
    });
    const after = await callToolOk(server.client, 'query_videos', { channel: CHANNEL_ID });
    expect(after.structured.total).toBe(4);
  });

  it('export_data writes the videos as JSON with the receipts for them inside', async () => {
    const { structured } = await callToolOk(server.client, 'export_data', {
      dataset: 'videos',
      format: 'json',
      channel: CHANNEL_ID,
    });

    expect(structured).toMatchObject({ rows: 4, total: 4, truncated: false });
    const doc = JSON.parse(await readFile(String(structured.filePath), 'utf-8')) as {
      rows: { videoId: string; detailed: boolean }[];
      coverage: { scope: string; complete: boolean }[];
    };
    expect(doc.rows).toHaveLength(4);
    expect(doc.coverage.map((receipt) => `${receipt.scope}:${String(receipt.complete)}`)).toEqual([
      'channel-catalog:true',
      'video-details:false',
    ]);
  });

  it('export_data writes CSV with the receipts in a file beside it', async () => {
    const { structured } = await callToolOk(server.client, 'export_data', {
      dataset: 'videos',
      format: 'csv',
      channel: CHANNEL_ID,
    });

    const csv = await readFile(String(structured.filePath), 'utf-8');
    expect(csv.split('\r\n')[0]).toContain('videoId,channelId,title');
    expect(csv.trimEnd().split('\r\n')).toHaveLength(5);
    const sidecar = JSON.parse(await readFile(String(structured.coveragePath), 'utf-8')) as {
      coverage: unknown[];
    };
    expect(sidecar.coverage).toHaveLength(2);
  });

  it('export_data refuses a path outside the home directory', async () => {
    const outcome = await callTool(server.client, 'export_data', {
      dataset: 'videos',
      outputDir: '/etc',
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('inside your home directory');
  });
});
