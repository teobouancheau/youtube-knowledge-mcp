import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/local-transcription.js', () => ({ transcribeLocally: vi.fn() }));

import { transcribeLocally } from '../../src/utils/local-transcription.js';
import { transcribeVideoHandler } from '../../src/tools/transcribe-video.js';

const RESULT = {
  transcript: 'hello there general kenobi',
  segments: [
    { start: 0, end: 2, text: 'hello there' },
    { start: 2, end: 61.5, text: 'general kenobi' },
  ],
  language: 'en',
  videoId: 'dQw4w9WgXcQ',
  cached: false,
  source: 'local-asr' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(transcribeLocally).mockResolvedValue(RESULT);
});

describe('transcribeVideoHandler', () => {
  it('forwards the video, the language and the refresh flag', async () => {
    await transcribeVideoHandler({ video: 'dQw4w9WgXcQ', language: 'fr', refresh: true });

    expect(transcribeLocally).toHaveBeenCalledWith('dQw4w9WgXcQ', {
      language: 'fr',
      refresh: true,
    });
  });

  it('reports what was transcribed, and that it is a local transcription', async () => {
    const result = await transcribeVideoHandler({
      video: 'dQw4w9WgXcQ',
      language: 'en',
      refresh: false,
    });

    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      language: 'en',
      source: 'local-asr',
      segmentCount: 2,
      wordCount: 4,
      durationSeconds: 61.5,
      cached: false,
    });
    expect(textOf(result)).toContain('Transcribed locally');
  });

  it('tells the caller where the transcript can now be read', async () => {
    const result = await transcribeVideoHandler({
      video: 'dQw4w9WgXcQ',
      language: 'en',
      refresh: false,
    });

    expect(textOf(result)).toContain('get_transcript');
    expect(textOf(result)).toContain('search_transcript');
  });

  it('says so when the transcription was already kept', async () => {
    vi.mocked(transcribeLocally).mockResolvedValue({ ...RESULT, cached: true });

    const result = await transcribeVideoHandler({
      video: 'dQw4w9WgXcQ',
      language: 'en',
      refresh: false,
    });

    expect(textOf(result)).toContain('Already transcribed');
    expect(structuredOf(result)).toMatchObject({ cached: true });
  });
});
