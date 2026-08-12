import { z } from 'zod';
import { getTranscript } from '../utils/youtube.js';
import { textContent } from '../utils/format.js';
import { YouTubeError } from '../utils/errors.js';
import { deepLink, formatTimestamp, searchSegments } from '../utils/transcript.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const searchTranscriptSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
  query: z
    .string()
    .min(1)
    .describe('Phrase to find in the transcript, or a regular expression when regex is true'),
  language: z.string().default('en').describe('Caption language to search. Default: en'),
  regex: z
    .boolean()
    .default(false)
    .describe('Treat query as a JavaScript regular expression. Default: false'),
  caseSensitive: z.boolean().default(false).describe('Match case exactly. Default: false'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum matches to return. Default: 20'),
  contextSeconds: z
    .number()
    .min(0)
    .max(120)
    .default(0)
    .describe(
      'Include surrounding transcript within this many seconds of each match, for reading the moment in context. Default: 0'
    ),
};

export interface SearchTranscriptArgs {
  video: string;
  query: string;
  language: string;
  regex: boolean;
  caseSensitive: boolean;
  limit: number;
  contextSeconds: number;
}

/**
 * Locate a phrase inside a video and hand back timestamps plus links.
 *
 * This is what turns a transcript from a wall of text into something citable:
 * the caller gets `?t=` URLs that open the video at the exact moment, which is
 * also the input clip extraction needs.
 */
export async function searchTranscriptHandler(args: SearchTranscriptArgs): Promise<CallToolResult> {
  const { video, query, language, regex, caseSensitive, limit, contextSeconds } = args;

  if (regex) {
    try {
      new RegExp(query);
    } catch (error) {
      throw new YouTubeError('INVALID_INPUT', `"${query}" is not a valid regular expression.`, {
        nextStep: 'Fix the pattern, or set regex=false to search for it literally.',
        cause: error,
      });
    }
  }

  const transcript = await getTranscript(video, { language });
  const matches = searchSegments(transcript.segments, query, { regex, caseSensitive, limit });

  if (matches.length === 0) {
    return textContent(
      [
        `No matches for "${query}" in this transcript.`,
        '',
        `Searched ${transcript.segments.length.toLocaleString()} caption segments in ${transcript.language}.`,
        'Try a shorter phrase, a different language, or get_transcript to read it in full.',
      ].join('\n')
    );
  }

  const lines: string[] = [
    `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query}"`,
    '',
  ];

  for (const { segment } of matches) {
    lines.push(`[${formatTimestamp(segment.start)}] ${segment.text}`);

    if (contextSeconds > 0) {
      const context = transcript.segments.filter(
        (candidate) =>
          candidate !== segment &&
          candidate.end > segment.start - contextSeconds &&
          candidate.start < segment.end + contextSeconds
      );
      if (context.length > 0) {
        lines.push(`    …${context.map((c) => c.text).join(' ')}`);
      }
    }

    lines.push(`    ${deepLink(transcript.videoId, segment.start)}`);
    lines.push('');
  }

  return textContent(lines.join('\n').trimEnd());
}
