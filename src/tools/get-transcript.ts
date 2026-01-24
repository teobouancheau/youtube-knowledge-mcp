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

  const output = {
    videoId: result.videoId,
    language: result.language,
    characterCount: result.transcript.length,
    wordCount: result.transcript.split(/\s+/).length,
    transcript: result.transcript,
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      },
    ],
  };
}
