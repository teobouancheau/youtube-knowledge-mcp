import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolResult } from '../utils/format.js';
import { transcribeLocally } from '../utils/local-transcription.js';
import { formatTimestamp } from '../utils/transcript.js';

/**
 * Transcribing a video's audio on this machine, for the videos YouTube has no
 * captions for. What it writes is read back by get_transcript, search_transcript,
 * export_subtitles and the channel brains, exactly like captions.
 */

export const transcribeVideoSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
  language: z
    .string()
    .default('en')
    .describe(
      'The language spoken in the video, as a tag such as en, fr or pt-BR. Always set it explicitly: guessing the language from the audio is unreliable. Default: en'
    ),
  refresh: z
    .boolean()
    .default(false)
    .describe('Transcribe again even if a transcription was already kept. Default: false'),
};

export const transcribeVideoOutputSchema = {
  videoId: z.string(),
  language: z.string(),
  source: z.literal('local-asr'),
  segmentCount: z.number().int(),
  wordCount: z.number().int(),
  durationSeconds: z.number().describe('Where the last transcribed segment ends'),
  cached: z.boolean().describe('True when a kept transcription was returned without redoing it'),
};

export interface TranscribeVideoArgs {
  video: string;
  language: string;
  refresh: boolean;
}

export async function transcribeVideoHandler(args: TranscribeVideoArgs): Promise<CallToolResult> {
  const { video, language, refresh } = args;
  const result = await transcribeLocally(video, { language, refresh });

  const wordCount = result.transcript.split(/\s+/).filter(Boolean).length;
  const durationSeconds = result.segments.at(-1)?.end ?? 0;

  const lines = [
    result.cached ? '✓ Already transcribed locally' : '✓ Transcribed locally',
    '',
    `${result.segments.length.toLocaleString()} segments, ${wordCount.toLocaleString()} words, ${formatTimestamp(durationSeconds)} (${result.language})`,
    '',
    'This is a machine transcription, not YouTube captions. Read it with get_transcript, find a phrase with search_transcript, or export it with export_subtitles.',
  ];

  return toolResult(lines.join('\n'), {
    videoId: result.videoId,
    language: result.language,
    source: result.source,
    segmentCount: result.segments.length,
    wordCount,
    durationSeconds,
    cached: result.cached,
  });
}
