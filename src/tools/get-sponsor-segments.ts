import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolResult } from '../utils/format.js';
import { videoMoment, videoMomentSchema } from '../utils/moment.js';
import { SPONSOR_CATEGORIES, coveredSeconds, fetchSponsorSegments } from '../utils/sponsorblock.js';
import { formatTimestamp } from '../utils/transcript.js';
import { extractVideoId } from '../utils/youtube.js';

/**
 * Where a video sells something or repeats itself, according to the SponsorBlock
 * community. It is their data, not YouTube's, and the result says so.
 */

export const getSponsorSegmentsSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
  categories: z
    .array(z.enum(SPONSOR_CATEGORIES))
    .min(1)
    .optional()
    .describe(
      'Which kinds of segment to return: sponsor, selfpromo, interaction (subscribe reminders), intro, outro, preview, music_offtopic, filler. Default: all'
    ),
};

const segmentSchema = videoMomentSchema.omit({ timestampSeconds: true }).extend({
  category: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  durationSeconds: z.number(),
  votes: z.number().describe('Community votes: higher is more agreed upon'),
});

export const getSponsorSegmentsOutputSchema = {
  videoId: z.string(),
  source: z.literal('sponsorblock'),
  count: z.number().int(),
  coveredSeconds: z.number().describe('Total length of the segments, in seconds'),
  segments: z.array(segmentSchema),
};

export async function getSponsorSegmentsHandler(args: {
  video: string;
  categories?: (typeof SPONSOR_CATEGORIES)[number][];
}): Promise<CallToolResult> {
  const videoId = extractVideoId(args.video);
  const found = await fetchSponsorSegments(videoId, args.categories);

  const segments = found.map((segment) => {
    const { timestamp, url } = videoMoment(videoId, segment.startSeconds);
    return { ...segment, timestamp, url };
  });
  const covered = coveredSeconds(found);

  const structured = {
    videoId,
    source: 'sponsorblock' as const,
    count: segments.length,
    coveredSeconds: covered,
    segments,
  };

  if (segments.length === 0) {
    return toolResult(
      [
        'No one has marked any segment of this video on SponsorBlock.',
        'That says nobody has contributed, not that the video has no sponsor or intro.',
      ].join('\n'),
      structured
    );
  }

  const lines = [
    `${String(segments.length)} segments, ${formatTimestamp(covered)} in all (community data from SponsorBlock)`,
    '',
    ...segments.map(
      (segment) =>
        `${segment.category}  ${formatTimestamp(segment.startSeconds)} – ${formatTimestamp(segment.endSeconds)}  (${String(segment.votes)} votes)`
    ),
  ];

  return toolResult(lines.join('\n'), structured);
}
