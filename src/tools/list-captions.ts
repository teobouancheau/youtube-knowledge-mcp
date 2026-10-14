import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolResult } from '../utils/format.js';
import { readVideoStats } from '../utils/video-stats-cache.js';

/**
 * Which caption languages a video has, read from the same saved copy as
 * get_video_details, so asking costs no extra request when that one was already made.
 */

/** Automatic captions come in every language YouTube can translate to; the text stays readable. */
const LISTED_AUTOMATIC_LANGUAGES = 25;
const ORIGINAL_SUFFIX = '-orig';

export const listCaptionsSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
};

export const listCaptionsOutputSchema = {
  videoId: z.string(),
  title: z.string(),
  hasCaptions: z.boolean(),
  manual: z.array(z.string()).describe('Language codes of captions a person wrote or uploaded'),
  automatic: z.array(z.string()).describe('Language codes YouTube generated or translated'),
  spokenLanguage: z
    .string()
    .optional()
    .describe('The language YouTube recognised in the audio, when it says'),
};

function sortedUnique(codes: string[]): string[] {
  return [...new Set(codes)].sort();
}

export async function listCaptionsHandler({ video }: { video: string }): Promise<CallToolResult> {
  const { stats } = await readVideoStats(video);

  const manual = sortedUnique(stats.captions.manual);
  const automatic = sortedUnique(
    stats.captions.automatic.filter((code) => !code.endsWith(ORIGINAL_SUFFIX))
  );
  const original = stats.captions.automatic.find((code) => code.endsWith(ORIGINAL_SUFFIX));
  const spokenLanguage = original?.slice(0, -ORIGINAL_SUFFIX.length);
  const hasCaptions = manual.length > 0 || automatic.length > 0;

  const structured = {
    videoId: stats.id,
    title: stats.title,
    hasCaptions,
    manual,
    automatic,
    ...(spokenLanguage === undefined ? {} : { spokenLanguage }),
  };

  if (!hasCaptions) {
    return toolResult(
      [
        `${stats.title}: this video has no captions in any language.`,
        'Use get_comments for viewer discussion, or get_video_info for the description.',
      ].join('\n'),
      structured
    );
  }

  const hidden = automatic.length - LISTED_AUTOMATIC_LANGUAGES;
  const lines = [
    stats.title,
    ...(spokenLanguage === undefined ? [] : [`Spoken language: ${spokenLanguage}`]),
    `Manual (${manual.length}): ${manual.join(', ') || 'none'}`,
    `Automatic (${automatic.length}): ${automatic.slice(0, LISTED_AUTOMATIC_LANGUAGES).join(', ') || 'none'}${hidden > 0 ? `, and ${hidden} more` : ''}`,
    '',
    'Pass any of these codes as language to get_transcript.',
  ];

  return toolResult(lines.join('\n'), structured);
}
