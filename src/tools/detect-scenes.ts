import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolResult } from '../utils/format.js';
import { parseOptionalTimestamp } from '../utils/validate.js';
import {
  DEFAULT_SCENE_THRESHOLD,
  MAX_SCENE_CUTS,
  MAX_SCENE_WINDOW_SECONDS,
  detectScenes,
} from '../utils/scenes.js';
import { formatTimestamp } from '../utils/transcript.js';
import { videoMoment, videoMomentSchema } from '../utils/moment.js';

/** Finding where a video cuts, so frames and clips can be taken at the right moments. */

export const detectScenesSchema = {
  video: z.string().describe('YouTube video ID or full URL'),
  start: z.string().optional().describe('Window start. Seconds, MM:SS or HH:MM:SS. Default: 0.'),
  end: z
    .string()
    .optional()
    .describe(
      `Window end. Seconds, MM:SS or HH:MM:SS. At most ${MAX_SCENE_WINDOW_SECONDS}s after start. Default: start plus that.`
    ),
  threshold: z
    .number()
    .min(0.1)
    .max(0.9)
    .default(DEFAULT_SCENE_THRESHOLD)
    .describe(
      `How different a frame must be from the last to count as a cut, 0.1 to 0.9. Lower finds subtler changes. Default: ${DEFAULT_SCENE_THRESHOLD}`
    ),
};

export const detectScenesOutputSchema = {
  videoId: z.string(),
  title: z.string(),
  windowStart: z.number(),
  windowEnd: z.number(),
  threshold: z.number(),
  truncated: z.boolean().describe(`True when more than ${MAX_SCENE_CUTS} cuts were found`),
  cuts: z.array(videoMomentSchema),
};

export interface DetectScenesArgs {
  video: string;
  start?: string;
  end?: string;
  threshold: number;
}

function summary(count: number): string {
  return count === 1 ? '1 scene cut' : `${count} scene cuts`;
}

export async function detectScenesHandler(args: DetectScenesArgs): Promise<CallToolResult> {
  const { video, threshold } = args;

  const scan = await detectScenes(video, {
    start: parseOptionalTimestamp(args.start, 'start'),
    end: parseOptionalTimestamp(args.end, 'end'),
    threshold,
  });

  const cuts = scan.cuts.map((seconds) => videoMoment(scan.videoId, seconds));
  const window = `${formatTimestamp(scan.start)} to ${formatTimestamp(scan.end)}`;

  const lines =
    cuts.length === 0
      ? [
          `No scene cuts between ${window} at threshold ${threshold}.`,
          'Lower the threshold to detect subtler changes.',
        ]
      : [
          `${scan.title}: ${summary(cuts.length)} between ${window} (threshold ${threshold})`,
          '',
          ...cuts.map((cut) => `${cut.timestamp}  ${cut.url}`),
          ...(scan.truncated
            ? ['', `Showing the first ${MAX_SCENE_CUTS}. Raise the threshold to see fewer cuts.`]
            : []),
        ];

  return toolResult(lines.join('\n'), {
    videoId: scan.videoId,
    title: scan.title,
    windowStart: scan.start,
    windowEnd: scan.end,
    threshold,
    truncated: scan.truncated,
    cuts,
  });
}
