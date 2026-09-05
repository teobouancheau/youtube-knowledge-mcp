import { z } from 'zod';
import { listedImageSchema, type ListedImage } from './flat-listing.js';
import { IMAGE_HOSTS } from './image-fetch.js';

/**
 * Picking a channel's avatar and banner out of the thumbnails yt-dlp lists for
 * the channel page.
 *
 * Verified against yt-dlp 2026.07.04: the array holds banner crops at several
 * widths, one `banner_uncropped`, a square avatar, and one `avatar_uncropped`.
 * The uncropped ids are preferred; should they ever be renamed, the fallback
 * needs nothing but widths and heights — the largest square is the avatar and
 * the widest image more than twice as wide as it is tall is the banner.
 */

export interface ChannelImages {
  avatarUrl?: string;
  bannerUrl?: string;
}

/** A listed image whose size is known. */
interface Sized {
  url: string;
  width: number;
  height: number;
}

const HOSTS = new Set<string>(IMAGE_HOSTS);

function onAllowedHost(image: ListedImage): boolean {
  try {
    const url = new URL(image.url);
    return url.protocol === 'https:' && HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function sized(images: ListedImage[]): Sized[] {
  return images.flatMap(({ url, width, height }) =>
    typeof width === 'number' && typeof height === 'number' ? [{ url, width, height }] : []
  );
}

function largest(images: Sized[], keep: (image: Sized) => boolean): Sized | undefined {
  return images.filter(keep).sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

export function selectChannelImages(thumbnails: unknown): ChannelImages {
  const parsed = z.array(listedImageSchema).safeParse(thumbnails);
  if (!parsed.success) return {};

  const images = parsed.data.filter(onAllowedHost);
  const measured = sized(images);

  const avatar =
    images.find((image) => image.id === 'avatar_uncropped') ??
    largest(measured, (image) => image.width === image.height);
  const banner =
    images.find((image) => image.id === 'banner_uncropped') ??
    largest(measured, (image) => image.width > 2 * image.height);

  return {
    ...(avatar === undefined ? {} : { avatarUrl: avatar.url }),
    ...(banner === undefined ? {} : { bannerUrl: banner.url }),
  };
}
