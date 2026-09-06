import { z } from 'zod';
import { YouTubeError } from './errors.js';

/**
 * The cursor `fetch_videos` hands back.
 *
 * YouTube's listings are continuation-paginated, so `--playlist-items 101:120`
 * still walks from the start: paging server-side is O(n) per page and O(n^2)
 * overall. It is also not a cursor in any useful sense — a new upload shifts
 * every index by one, so an offset silently re-reads or skips at the seam.
 *
 * So the cursor carries the next index *and* the id of the last item already
 * returned. If that id reappears on the next page the listing moved under us,
 * and the duplicate is dropped rather than handed over twice.
 */

const cursorSchema = z.object({
  v: z.literal(1),
  start: z.number().int().min(1),
  anchor: z.string(),
});

export type ListingCursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: ListingCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(token: string): ListingCursor {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
  })();

  const result = cursorSchema.safeParse(parsed);
  if (result.success) return result.data;

  throw new YouTubeError('INVALID_INPUT', 'That cursor is not one this server issued.', {
    nextStep: 'Omit `cursor` to start from the first page.',
  });
}
