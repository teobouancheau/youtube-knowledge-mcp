import { z } from 'zod';
import { deepLink, formatTimestamp } from './transcript.js';

/**
 * A point in a video, in every form a caller needs it.
 *
 * Frames, contact-sheet cells and scene cuts all answer "when", and each used to
 * need the same three spellings of it: seconds to compute with, a clock reading to
 * show a person, and a link that opens the video there.
 */

export const videoMomentSchema = z.object({
  timestampSeconds: z.number(),
  timestamp: z.string().describe('Clock reading, H:MM:SS or M:SS'),
  url: z.string().describe('Link that opens the video at this moment'),
});

export type VideoMoment = z.infer<typeof videoMomentSchema>;

export function videoMoment(videoId: string, seconds: number): VideoMoment {
  return {
    timestampSeconds: seconds,
    timestamp: formatTimestamp(seconds),
    url: deepLink(videoId, seconds),
  };
}
