import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { throwIfAborted } from './context.js';
import { YouTubeError } from './errors.js';
import { flatEntrySchema, toVideoListItem } from './flat-listing.js';
import { HARVEST_TABS, isAbsentTab, listTab, type HarvestTab } from './harvest-catalog.js';
import { readReceipt } from './harvest-receipts.js';
import { queryRows } from './store-rows.js';
import { catalogCounts } from './video-detail-store.js';
import { getChannelInfo } from './youtube-channel.js';
import { watchUrl } from './youtube-url.js';
import { parseYtDlpJsonLines } from './ytdlp-parse.js';

/**
 * What a channel has published since its catalogue was made.
 *
 * Looks at the newest few videos of each tab and names the ones the store has never
 * seen. It reads and compares; it does not add, so what is new can be inspected
 * before deciding to catalogue it. A channel is not watched: this runs when asked.
 */

export const DEFAULT_LOOKBACK = 30;
export const MAX_LOOKBACK = 200;

export interface CheckedTab {
  tab: HarvestTab;
  listed: number;
  error?: string;
}

export interface NewUpload {
  videoId: string;
  title: string;
  tab: HarvestTab;
  url: string;
  durationSeconds?: number;
}

export interface UploadCheck {
  channelId: string;
  name: string;
  handle: string;
  lookback: number;
  checked: CheckedTab[];
  newVideos: NewUpload[];
  /** When the catalogue was last written, so "nothing new" can be read against its age. */
  catalogHarvestedAt?: string;
  catalogComplete: boolean;
}

interface Listed {
  tab: HarvestTab;
  entries: ReturnType<typeof toVideoListItem>[];
  error?: YouTubeError;
}

async function listRecent(channelUrl: string, tab: HarvestTab, lookback: number): Promise<Listed> {
  try {
    const stdout = await listTab(channelUrl, tab, lookback, `check_new_uploads:${tab}`);
    return { tab, entries: parseYtDlpJsonLines(stdout, flatEntrySchema).map(toVideoListItem) };
  } catch (error) {
    if (isAbsentTab(error)) return { tab, entries: [] };
    const failure =
      error instanceof YouTubeError
        ? error
        : new YouTubeError('YTDLP_FAILED', String(error), { cause: error });
    return { tab, entries: [], error: failure };
  }
}

function knownIds(database: DatabaseSync, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(', ');
  return new Set(
    queryRows(
      database.prepare(`SELECT video_id FROM video WHERE video_id IN (${placeholders})`),
      z.object({ video_id: z.string() }),
      ...ids
    ).map((row) => row.video_id)
  );
}

export async function checkNewUploads(
  database: DatabaseSync,
  channel: string,
  options: { lookback: number }
): Promise<UploadCheck> {
  const { lookback } = options;
  const info = await getChannelInfo(channel);

  if (catalogCounts(database, info.channelId).videos === 0) {
    throw new YouTubeError('NOT_FOUND', `${info.name} has not been catalogued yet.`, {
      nextStep: 'Call harvest_channel first: there is nothing to compare new uploads against.',
    });
  }

  const listed: Listed[] = [];
  for (const tab of HARVEST_TABS) {
    throwIfAborted();
    listed.push(await listRecent(info.channelUrl, tab, lookback));
  }

  const failed = listed.flatMap((tab) => (tab.error === undefined ? [] : [tab.error]));
  const [firstFailure] = failed;
  if (firstFailure !== undefined && failed.length === listed.length) throw firstFailure;

  const known = knownIds(database, [
    ...new Set(listed.flatMap((tab) => tab.entries.map((entry) => entry.id))),
  ]);

  const seen = new Set<string>();
  const newVideos: NewUpload[] = [];
  for (const { tab, entries } of listed) {
    for (const entry of entries) {
      if (known.has(entry.id) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      newVideos.push({
        videoId: entry.id,
        title: entry.title,
        tab,
        url: watchUrl(entry.id),
        ...(entry.duration > 0 ? { durationSeconds: entry.duration } : {}),
      });
    }
  }

  const receipt = readReceipt(database, 'channel-catalog', info.channelId);

  return {
    channelId: info.channelId,
    name: info.name,
    handle: info.handle,
    lookback,
    checked: listed.map(({ tab, entries, error }) => ({
      tab,
      listed: entries.length,
      ...(error === undefined ? {} : { error: error.message }),
    })),
    newVideos,
    ...(receipt === undefined ? {} : { catalogHarvestedAt: receipt.harvestedAt }),
    catalogComplete: receipt?.complete === true,
  };
}
