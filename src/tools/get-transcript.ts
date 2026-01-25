import { z } from 'zod';
import { getTranscript } from '../utils/youtube.js';

export const getTranscriptSchema = {
  video: z.string().describe('YouTube video ID or URL'),
  language: z.string().default('en').describe('Preferred language code (e.g., en, fr, es)'),
};

export async function getTranscriptHandler({
  video,
  language,
}: {
  video: string;
  language: string;
}) {
  const result = await getTranscript(video, language);

  const wordCount = result.transcript.split(/\s+/).length;

  const lines: string[] = [
    `Transcript (${result.language})`,
    `${wordCount.toLocaleString()} words`,
    '',
    result.transcript,
  ];

  return {
    content: [
      {
        type: 'text' as const,
        text: lines.join('\n'),
      },
    ],
  };
}
