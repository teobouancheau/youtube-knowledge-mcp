import { probeImage, type ImageProbe } from './image-dimensions.js';
import { fetchImage } from './image-fetch.js';
import type { ListedImage } from './flat-listing.js';
import type { ThumbnailQuality } from '../thumbnail-schemas.js';
import { YouTubeError } from './errors.js';

/**
 * Getting the best thumbnail YouTube will serve for one video.
 *
 * A flat channel listing offers each video's thumbnail at up to 720 pixels
 * wide (verified against yt-dlp 2026.07.04). YouTube also serves a larger
 * `maxresdefault.jpg` for many videos — the probed video returned one at
 * 1280 wide — but not, as far as this code knows, for every video, and a
 * missing one is not guaranteed to be a 404. So the ladder tries it and then
 * checks what came back: an image is accepted only if it decodes and is wider
 * than the listed one. Anything else falls through to the next rung. No
 * behaviour of YouTube's is assumed that a rung could not verify for itself.
 */

export interface Rung {
  variant: string;
  url: string;
  /** Accept the image only if it decodes wider than this. */
  mustExceedWidth?: number;
}

export interface Climbed {
  bytes: Buffer;
  probe: ImageProbe;
  rung: Rung;
}

const named = (videoId: string, variant: string, mustExceedWidth?: number): Rung => ({
  variant,
  url: `https://i.ytimg.com/vi/${videoId}/${variant}.jpg`,
  ...(mustExceedWidth === undefined ? {} : { mustExceedWidth }),
});

/**
 * The rungs for one video, best first.
 *
 * Shorts are listed with portrait thumbnails; whether `maxresdefault` exists
 * for a short, or is portrait when it does, is not verified, so a short uses
 * its listed image and the small landscape fallback only.
 */
export function videoRungs(
  videoId: string,
  listed: ListedImage | undefined,
  isShort: boolean,
  quality: ThumbnailQuality
): Rung[] {
  const listedRung: Rung[] = listed === undefined ? [] : [{ variant: 'listed', url: listed.url }];
  const fallback = named(videoId, 'hqdefault');

  if (isShort) return [...listedRung, fallback];

  if (quality === 'listed') return [...listedRung, fallback];

  const best = named(videoId, 'maxresdefault', listed?.width ?? 200);
  // With no listing to beat, the smaller named sizes are worth trying too.
  return listed === undefined
    ? [best, named(videoId, 'sddefault'), fallback]
    : [best, ...listedRung, fallback];
}

/** The reasons to stop climbing: they are about the client, not the rung. */
const ABORTING = new Set(['RATE_LIMITED', 'TIMEOUT', 'CANCELLED']);

/**
 * Fetch rungs in order and return the first acceptable image.
 *
 * A rung is accepted when it downloads, decodes as an image this server reads,
 * and — where the rung demands it — is wider than the listed image. A 404 or
 * an unacceptable image moves to the next rung; rate limiting, a timeout or a
 * cancelled request stops the climb immediately.
 */
export async function climb(rungs: Rung[], maxBytes: number): Promise<Climbed> {
  let last: YouTubeError | undefined;

  for (const rung of rungs) {
    try {
      const { bytes } = await fetchImage(rung.url, { maxBytes });
      const probe = probeImage(bytes);
      if (probe === undefined) {
        last = new YouTubeError(
          'FETCH_FAILED',
          'The response was not an image this server can read.'
        );
        continue;
      }
      if (rung.mustExceedWidth !== undefined && probe.width <= rung.mustExceedWidth) {
        last = new YouTubeError('NOT_FOUND', 'No larger image is available at that address.');
        continue;
      }
      return { bytes, probe, rung };
    } catch (error) {
      if (!(error instanceof YouTubeError)) throw error;
      if (ABORTING.has(error.code)) throw error;
      last = error;
    }
  }

  throw (
    last ??
    new YouTubeError('NOT_FOUND', 'No thumbnail address was available for this video.', {
      nextStep: 'The listing carried no thumbnail; try again later.',
    })
  );
}
