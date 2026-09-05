import type { ThumbnailTab } from '../thumbnail-schemas.js';
import { asYouTubeError } from './errors.js';
import type { TabListing } from './thumbnail-entry.js';
import { listVideos, type VideoListItem } from './youtube.js';

/**
 * List each tab. The uploads tab must list — every channel has one, so a
 * failure there is worth reporting. Whether yt-dlp lists an empty shorts or
 * streams tab or refuses it is not verified, so those failures are recorded
 * per tab and the run continues.
 */
export async function listTabs(
  channelUrl: string,
  tabs: ThumbnailTab[],
  maxVideos: number
): Promise<{ listings: TabListing[]; tabErrors: { tab: ThumbnailTab; error: string }[] }> {
  const base = channelUrl.replace(/\/+$/, '');
  const listings: TabListing[] = [];
  const tabErrors: { tab: ThumbnailTab; error: string }[] = [];

  for (const tab of tabs) {
    try {
      const videos: VideoListItem[] = (await listVideos(`${base}/${tab}`, maxVideos)).slice(
        0,
        maxVideos
      );
      listings.push({ tab, videos });
    } catch (error) {
      if (tab === 'videos') throw error;
      tabErrors.push({ tab, error: asYouTubeError(error).code });
    }
  }
  return { listings, tabErrors };
}
