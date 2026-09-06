import type { DatabaseSync } from 'node:sqlite';
import { runYtDlp, TIMEOUTS } from './ytdlp.js';
import { FLAT_PRINT_TEMPLATE, flatEntrySchema, toVideoListItem } from './flat-listing.js';
import { parseYtDlpJsonLines } from './ytdlp-parse.js';
import { resolveListTarget } from './youtube-url.js';
import { getChannelInfo } from './youtube-channel.js';
import { coverageOf } from './coverage.js';
import { saveReceipt } from './harvest-receipts.js';
import { inTransaction } from './store.js';
import { throwIfAborted, reportProgress } from './context.js';
import { countRows } from './store-rows.js';
import { withChannelHarvestLock } from './harvest-lock.js';
import { YouTubeError } from './errors.js';
import type { Coverage } from '../harvest-schemas.js';

/**
 * Reading a channel's whole catalogue.
 *
 * The listing plane is cheap and is not bot-checked: measured 1,716 videos in
 * 31 seconds from one spawn, so a catalogue costs about a minute per channel
 * and the old 100-video cap was self-imposed rather than forced.
 *
 * Every tab is walked because a channel's videos are not all under /videos —
 * shorts, streams, releases and podcasts each have their own. The first tab
 * that lists a video owns it; later tabs record themselves in `also_in_tabs`.
 * Last-writer-wins would mislabel most of a music channel's catalogue.
 */

export const HARVEST_TABS = ['videos', 'shorts', 'streams', 'releases', 'podcasts'] as const;
export type HarvestTab = (typeof HARVEST_TABS)[number];

export const MAX_VIDEOS_PER_CATALOG = 10_000;

/** yt-dlp says this, in these words, for a tab the channel does not have. */
const NO_SUCH_TAB = 'does not have a';

export interface TabResult {
  tab: HarvestTab;
  listed: number;
  added: number;
  complete: boolean;
  error?: string;
}

export interface CatalogResult {
  channelId: string;
  name: string;
  handle: string;
  tabs: TabResult[];
  videosSeen: number;
  videosAdded: number;
  coverage: Coverage;
}

const UPSERT_VIDEO = `
INSERT INTO video (
  video_id, channel_id, title, duration_s, upload_date, view_count,
  live_status, thumbnail_url, tab, also_in_tabs, catalog_rank, listed_at
) VALUES (?,?,?,?,?,?,?,?,?,'[]',?,?)
ON CONFLICT(video_id) DO UPDATE SET
  title = excluded.title,
  duration_s = excluded.duration_s,
  view_count = excluded.view_count,
  live_status = excluded.live_status,
  thumbnail_url = excluded.thumbnail_url,
  listed_at = excluded.listed_at,
  -- The owning tab is kept; a later tab only records that it also lists this
  -- video, so a re-walk in a different order cannot relabel the catalogue.
  also_in_tabs = CASE
    WHEN video.tab = excluded.tab THEN video.also_in_tabs
    WHEN instr(video.also_in_tabs, excluded.tab) > 0 THEN video.also_in_tabs
    ELSE json_insert(video.also_in_tabs, '$[#]', excluded.tab)
  END`;

async function listTab(channelUrl: string, tab: HarvestTab, limit: number): Promise<string> {
  return runYtDlp(
    [
      '--skip-download',
      '--flat-playlist',
      '--lazy-playlist',
      '--print',
      FLAT_PRINT_TEMPLATE,
      '--playlist-end',
      String(limit),
    ],
    {
      label: `harvest_channel:${tab}`,
      timeoutMs: TIMEOUTS.transcript,
      target: resolveListTarget(`${channelUrl}/${tab}`),
    }
  );
}

/**
 * Walks every tab of a channel into the store.
 *
 * A tab the channel simply does not have is not a failure — yt-dlp says so in
 * words, and treating that as an error would make every channel without a
 * podcasts tab look broken.
 */
export async function harvestCatalog(
  database: DatabaseSync,
  channel: string,
  options: { maxVideos?: number } = {}
): Promise<CatalogResult> {
  const maxVideos = Math.min(options.maxVideos ?? 500, MAX_VIDEOS_PER_CATALOG);

  // Resolving the channel comes before the lock because the lock is keyed on
  // the channel id, and only YouTube can turn a handle into one.
  const info = await getChannelInfo(channel);

  return withChannelHarvestLock(info.channelId, () => walkTabs(database, info, maxVideos));
}

async function walkTabs(
  database: DatabaseSync,
  info: Awaited<ReturnType<typeof getChannelInfo>>,
  maxVideos: number
): Promise<CatalogResult> {
  const now = Date.now();

  database
    .prepare(
      `INSERT INTO channel (channel_id, handle, name, channel_url, subscriber_count, description, first_seen_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(channel_id) DO UPDATE SET
         handle = excluded.handle, name = excluded.name, channel_url = excluded.channel_url,
         subscriber_count = excluded.subscriber_count, description = excluded.description,
         updated_at = excluded.updated_at`
    )
    .run(
      info.channelId,
      info.handle,
      info.name,
      info.channelUrl,
      info.subscriberCount,
      info.description,
      now,
      now
    );

  const tabs: TabResult[] = [];
  const seen = new Set<string>();
  let rank = 0;

  // Counted from the store, not from `seen`: on a second run every video is
  // new to the walk and none is new to the catalogue, and reporting the former
  // as "added" would make a re-run look like a fresh harvest.
  const countVideos = (): number =>
    countRows(database.prepare('SELECT COUNT(*) FROM video WHERE channel_id = ?'), info.channelId);
  const before = countVideos();

  for (const tab of HARVEST_TABS) {
    throwIfAborted();
    reportProgress(tabs.length, HARVEST_TABS.length, `harvest_channel: ${tab}`);

    let stdout: string;
    try {
      stdout = await listTab(info.channelUrl, tab, maxVideos);
    } catch (error) {
      const message = error instanceof YouTubeError ? error.message : String(error);
      const absent = error instanceof YouTubeError && error.message.includes(NO_SUCH_TAB);
      tabs.push({
        tab,
        listed: 0,
        added: 0,
        // A tab the channel does not have is a complete answer, not a gap.
        complete: absent,
        ...(absent ? {} : { error: message }),
      });
      continue;
    }

    const entries = parseYtDlpJsonLines(stdout, flatEntrySchema).map(toVideoListItem);
    const insert = database.prepare(UPSERT_VIDEO);
    const tabBefore = countVideos();

    inTransaction(database, () => {
      for (const entry of entries) {
        if (seen.size >= maxVideos) break;
        seen.add(entry.id);
        insert.run(
          entry.id,
          info.channelId,
          entry.title,
          entry.duration,
          entry.uploadDate === '' ? null : entry.uploadDate,
          entry.viewCount ?? null,
          entry.liveStatus ?? null,
          entry.thumbnailUrl ?? null,
          tab,
          rank,
          now
        );
        rank += 1;
      }
    });

    tabs.push({
      tab,
      listed: entries.length,
      added: countVideos() - tabBefore,
      complete: entries.length < maxVideos,
    });
  }

  const everyTabComplete = tabs.every((tab) => tab.complete);
  const coverage = coverageOf({
    scope: 'channel-catalog',
    targetId: info.channelId,
    have: seen.size,
    source: `yt-dlp --flat-playlist over ${HARVEST_TABS.join(', ')}`,
    // Only an unbroken walk of every tab proves the catalogue is whole. A tab
    // that errored, or one that filled to the cap, leaves it unprovable.
    ...(everyTabComplete
      ? {
          expected: { value: seen.size, source: 'source-exhausted' as const },
          ranToExhaustion: true,
        }
      : {}),
    ...(seen.size >= maxVideos ? { limitApplied: maxVideos } : {}),
    ...(everyTabComplete ? {} : { resumeToken: `catalog:${info.channelId}` }),
  });

  inTransaction(database, () => {
    saveReceipt(database, coverage, { startedAt: now });
  });

  return {
    channelId: info.channelId,
    name: info.name,
    handle: info.handle,
    tabs,
    videosSeen: seen.size,
    videosAdded: countVideos() - before,
    coverage,
  };
}
