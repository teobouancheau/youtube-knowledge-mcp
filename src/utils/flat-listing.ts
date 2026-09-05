import { z } from 'zod';
import { formatYouTubeDate } from './format.js';
import { formatDuration, watchUrl } from './youtube-url.js';
import type { VideoListItem } from './youtube-channel.js';

/**
 * Reading a flat channel or playlist listing.
 *
 * `--flat-playlist` lists a channel in one request instead of one per video,
 * and each entry carries its thumbnail URLs — which is what makes a channel's
 * thumbnails reachable without extracting every video. Printed as one JSON
 * object per line with exactly these fields, so a title containing a delimiter
 * cannot shift the others, and the parser checks each field's type.
 *
 * Verified against yt-dlp 2026.07.04: a flat entry carries `thumbnails` but no
 * `upload_date`, so the date stays empty here and is resolved per video by the
 * callers that need it.
 */

export const FLAT_PRINT_TEMPLATE =
  '%(.{id,title,duration,upload_date,timestamp,view_count,live_status,availability,thumbnails})j';

/** One entry of a thumbnails array; sizes are absent for some channel images. */
export const listedImageSchema = z.object({
  id: z.string().nullish(),
  url: z.string(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});

export type ListedImage = z.infer<typeof listedImageSchema>;

export const flatEntrySchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  duration: z.number().nullish(),
  upload_date: z.string().nullish(),
  view_count: z.number().nullish(),
  live_status: z.string().nullish(),
  thumbnails: z.array(listedImageSchema).nullish(),
});

export type FlatEntry = z.infer<typeof flatEntrySchema>;

/** The largest image by area, then by width; `undefined` for an empty list. */
export function largestThumbnail(thumbnails: ListedImage[]): ListedImage | undefined {
  const area = (image: ListedImage): number => (image.width ?? 0) * (image.height ?? 0);
  return thumbnails.reduce<ListedImage | undefined>((best, image) => {
    if (best === undefined) return image;
    if (area(image) > area(best)) return image;
    if (area(image) === area(best) && (image.width ?? 0) > (best.width ?? 0)) return image;
    return best;
  }, undefined);
}

export function toVideoListItem(entry: FlatEntry): VideoListItem {
  const duration = entry.duration ?? 0;
  const thumbnails = entry.thumbnails ?? [];
  const largest = largestThumbnail(thumbnails);

  return {
    id: entry.id,
    title: entry.title ?? 'Unknown title',
    duration,
    durationFormatted: formatDuration(duration),
    uploadDate: formatYouTubeDate(entry.upload_date ?? ''),
    url: watchUrl(entry.id),
    ...(largest === undefined ? {} : { thumbnailUrl: largest.url }),
    ...(thumbnails.length === 0 ? {} : { thumbnails }),
    ...(entry.view_count === null || entry.view_count === undefined
      ? {}
      : { viewCount: entry.view_count }),
    ...(entry.live_status === null || entry.live_status === undefined
      ? {}
      : { liveStatus: entry.live_status }),
  };
}
