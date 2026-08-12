import { z } from 'zod';
import { getTranscript } from '../utils/youtube.js';
import { textContent } from '../utils/format.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const getTranscriptSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
  language: z
    .string()
    .default('en')
    .describe(
      'Preferred caption language as ISO 639-1 code (e.g., en, fr, es, de). Falls back to available language if unavailable. Default: en'
    ),
};

export async function getTranscriptHandler({
  video,
  language,
}: {
  video: string;
  language: string;
}): Promise<CallToolResult> {
  const result = await getTranscript(video, language);

  const wordCount = result.transcript.split(/\s+/).length;

  const lines: string[] = [
    `Transcript (${result.language})`,
    `${wordCount.toLocaleString()} words`,
    '',
    result.transcript,
  ];

  return textContent(lines.join('\n'));
}
