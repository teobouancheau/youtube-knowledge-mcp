/**
 * What of a video's record is kept in the store.
 *
 * Measured on a 637KB payload: `automatic_captions` is 460,965 bytes (72%) of URLs that
 * expire, `formats` another 113,601 (18%), and `heatmap` 6,589 — larger than the whole
 * rest of the record, so it has its own column. Stripped, a video is 4,785 bytes. Storing
 * the raw object would cost 6.4GB per 10,000 videos instead of 48MB.
 */

/** A stored snapshot must stay small enough that a catalogue is not mostly URLs. */
export const MAX_DETAIL_JSON_BYTES = 32_768;

/** Keys dropped before storage: expiring URLs and bulk we can re-fetch. */
export const STRIPPED_KEYS = [
  'formats',
  'requested_formats',
  'automatic_captions',
  'subtitles',
  'thumbnails',
  'comments',
  'heatmap',
] as const;

export const CATALOG_DESCRIPTION_PREVIEW_CHARS = 500;

/** Drops the bulk keys, so what is stored is the record rather than its attachments. */
export function stripForStorage(raw: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (STRIPPED_KEYS.some((stripped) => stripped === key)) continue;
    kept[key] = value;
  }

  const description = kept.description;
  if (typeof description === 'string' && description.length > CATALOG_DESCRIPTION_PREVIEW_CHARS) {
    kept.description = description.slice(0, CATALOG_DESCRIPTION_PREVIEW_CHARS);
    kept.description_truncated = true;
  }

  return kept;
}
