import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';

const { home } = vi.hoisted(() => ({
  home: `${process.env.TMPDIR ?? '/tmp'}/yk-fallback-${String(process.pid)}-${String(Date.now())}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home };
});
vi.mock('../../src/utils/ytdlp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/ytdlp.js')>()),
  runYtDlp: vi.fn(),
}));
vi.mock('../../src/utils/caption-probe.js', () => ({ noCaptionsError: vi.fn() }));

import { runYtDlp } from '../../src/utils/ytdlp.js';
import { noCaptionsError } from '../../src/utils/caption-probe.js';
import { YouTubeError } from '../../src/utils/errors.js';
import {
  TRANSCRIPT_DIR,
  asrPath,
  captionsPath,
  writeTranscriptFile,
} from '../../src/utils/transcript-files.js';
import { TRANSCRIPT_CACHE_VERSION } from '../../src/utils/transcript.js';
import { getTranscript } from '../../src/utils/transcript-cache.js';

const VIDEO_ID = 'dQw4w9WgXcQ';

function entry(text: string, language = 'en'): Parameters<typeof writeTranscriptFile>[1] {
  return {
    version: TRANSCRIPT_CACHE_VERSION,
    videoId: VIDEO_ID,
    language,
    fetchedAt: new Date().toISOString(),
    segments: [{ start: 0, end: 2, text }],
  };
}

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  vi.clearAllMocks();
  // yt-dlp finds no caption files, and the probe says why.
  vi.mocked(runYtDlp).mockResolvedValue('');
  vi.mocked(noCaptionsError).mockResolvedValue(
    new YouTubeError('NO_CAPTIONS', 'This video has no captions in any language.')
  );
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('getTranscript when a video has no captions', () => {
  it('falls back to a transcription made locally, and says that is what it is', async () => {
    await writeTranscriptFile(asrPath(VIDEO_ID, 'en'), entry('heard by whisper'));

    const result = await getTranscript(VIDEO_ID);

    expect(result).toMatchObject({
      transcript: 'heard by whisper',
      source: 'local-asr',
      cached: true,
    });
  });

  it('reports the no-captions error when nothing was transcribed either', async () => {
    await expect(getTranscript(VIDEO_ID)).rejects.toMatchObject({ code: 'NO_CAPTIONS' });
  });

  it('does not use a transcription made in another language', async () => {
    await writeTranscriptFile(asrPath(VIDEO_ID, 'fr'), entry('entendu', 'fr'));

    await expect(getTranscript(VIDEO_ID, { language: 'en' })).rejects.toMatchObject({
      code: 'NO_CAPTIONS',
    });
  });

  it('does not reach for a transcription when the failure was something else', async () => {
    await writeTranscriptFile(asrPath(VIDEO_ID, 'en'), entry('heard by whisper'));
    vi.mocked(runYtDlp).mockRejectedValue(new YouTubeError('PRIVATE', 'This video is private.'));

    await expect(getTranscript(VIDEO_ID)).rejects.toMatchObject({ code: 'PRIVATE' });
  });
});

describe('getTranscript when the video has captions', () => {
  it('prefers kept captions over a local transcription of the same video', async () => {
    await writeTranscriptFile(captionsPath(VIDEO_ID, 'en'), entry('written by a person'));
    await writeTranscriptFile(asrPath(VIDEO_ID, 'en'), entry('heard by whisper'));

    const result = await getTranscript(VIDEO_ID);

    expect(result).toMatchObject({ transcript: 'written by a person', source: 'captions' });
    expect(runYtDlp).not.toHaveBeenCalled();
  });
});
