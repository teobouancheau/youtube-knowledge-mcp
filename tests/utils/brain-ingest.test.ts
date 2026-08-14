import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BRAIN_FULL,
  MAX_CHUNKS_PER_BRAIN,
  MAX_CHUNKS_PER_VIDEO,
  TOO_LARGE,
  ingestVideo,
} from '../../src/utils/brain-ingest.js';
import { CHUNK_MAX_CHARS } from '../../src/utils/brain-chunks.js';
import { YouTubeError } from '../../src/utils/errors.js';
import { segmentsToText, type TranscriptSegment } from '../../src/utils/transcript.js';
import type { TranscriptResult, VideoListItem } from '../../src/utils/youtube.js';

vi.mock('../../src/utils/youtube.js', () => ({
  getTranscript: vi.fn(),
  getChapters: vi.fn(),
}));

const VIDEO: VideoListItem = {
  id: 'vid1',
  title: 'A long one',
  duration: 3600,
  durationFormatted: '1:00:00',
  uploadDate: '2025-02-02',
  url: 'https://www.youtube.com/watch?v=vid1',
};

function transcript(segments: TranscriptSegment[]): TranscriptResult {
  return {
    videoId: VIDEO.id,
    language: 'en',
    segments,
    transcript: segmentsToText(segments),
    cached: false,
  };
}

/** Each segment is over the hard ceiling, so each becomes its own passage. */
function oversizedSegments(count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_unused, index) => ({
    start: index * 10,
    end: index * 10 + 10,
    text: 'word '.repeat(Math.ceil((CHUNK_MAX_CHARS + 100) / 5)),
  }));
}

async function youtube(): Promise<typeof import('../../src/utils/youtube.js')> {
  return import('../../src/utils/youtube.js');
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { getChapters } = await youtube();
  vi.mocked(getChapters).mockResolvedValue([]);
});

describe('ingestVideo', () => {
  it('reads a video into passages and counts its words', async () => {
    const { getTranscript } = await youtube();
    vi.mocked(getTranscript).mockResolvedValue(
      transcript([{ start: 0, end: 10, text: 'four words go here' }])
    );

    const { state, chunks } = await ingestVideo(VIDEO, 0, 'en');

    expect(state).toMatchObject({ state: 'indexed', chunkCount: 1, wordCount: 4 });
    expect(chunks[0]?.text).toBe('four words go here');
  });

  it('carries on when a video has no chapters', async () => {
    const { getTranscript, getChapters } = await youtube();
    vi.mocked(getTranscript).mockResolvedValue(
      transcript([{ start: 0, end: 10, text: 'still readable' }])
    );
    vi.mocked(getChapters).mockRejectedValue(new YouTubeError('NOT_FOUND', 'no chapters'));

    const { state } = await ingestVideo(VIDEO, 0, 'en');

    expect(state.state).toBe('indexed');
  });

  it('separates a video nobody captioned from one that failed', async () => {
    const { getTranscript } = await youtube();

    vi.mocked(getTranscript).mockRejectedValue(new YouTubeError('NO_CAPTIONS', 'none'));
    expect((await ingestVideo(VIDEO, 0, 'en')).state).toMatchObject({ state: 'no-captions' });

    vi.mocked(getTranscript).mockRejectedValue(new YouTubeError('MEMBERS_ONLY', 'no'));
    expect((await ingestVideo(VIDEO, 0, 'en')).state).toMatchObject({
      state: 'failed',
      error: 'MEMBERS_ONLY',
    });
  });

  it('refuses a transcript too large to be a transcript', async () => {
    const { getTranscript } = await youtube();
    vi.mocked(getTranscript).mockResolvedValue(
      transcript(oversizedSegments(MAX_CHUNKS_PER_VIDEO + 1))
    );

    const { state, chunks } = await ingestVideo(VIDEO, 0, 'en');

    expect(state).toMatchObject({ state: 'failed', error: TOO_LARGE });
    expect(chunks).toEqual([]);
  });

  it('refuses to grow a brain past its ceiling', async () => {
    const { getTranscript } = await youtube();
    vi.mocked(getTranscript).mockResolvedValue(
      transcript([{ start: 0, end: 10, text: 'one more passage' }])
    );

    const { state, chunks } = await ingestVideo(VIDEO, MAX_CHUNKS_PER_BRAIN, 'en');

    expect(state).toMatchObject({ state: 'failed', error: BRAIN_FULL });
    expect(chunks).toEqual([]);
  });
});
