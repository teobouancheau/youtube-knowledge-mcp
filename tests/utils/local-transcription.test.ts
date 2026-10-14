import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const { home } = vi.hoisted(() => ({
  home: `${process.env.TMPDIR ?? '/tmp'}/yk-asr-${String(process.pid)}-${String(Date.now())}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home };
});
vi.mock('../../src/utils/ytdlp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/ytdlp.js')>()),
  runYtDlp: vi.fn(),
}));
vi.mock('../../src/utils/preflight.js', () => ({ requireFfmpeg: vi.fn() }));
vi.mock('../../src/utils/whisper.js', () => ({ requireWhisper: vi.fn(), runWhisper: vi.fn() }));

import { runYtDlp } from '../../src/utils/ytdlp.js';
import { requireFfmpeg } from '../../src/utils/preflight.js';
import { requireWhisper, runWhisper } from '../../src/utils/whisper.js';
import { asrPath } from '../../src/utils/transcript-files.js';
import { transcribeLocally } from '../../src/utils/local-transcription.js';
import { YouTubeError } from '../../src/utils/errors.js';

const VIDEO_ID = 'dQw4w9WgXcQ';
const MODEL = '/models/ggml-base.bin';
const SEGMENTS = [
  { start: 0, end: 2, text: 'hello there' },
  { start: 2, end: 4, text: 'general kenobi' },
];

/** yt-dlp as it behaves on success: it leaves the converted audio where `-o` pointed. */
function downloadsAudio(): void {
  vi.mocked(runYtDlp).mockImplementation((args: string[]) => {
    const template = args[args.indexOf('-o') + 1] ?? '';
    writeFileSync(template.replace('%(ext)s', 'wav'), 'RIFF');
    return Promise.resolve('');
  });
}

function ytDlpArgs(): string[] {
  return vi.mocked(runYtDlp).mock.calls[0]?.[0] ?? [];
}

function audioPassedToWhisper(): string {
  return vi.mocked(runWhisper).mock.calls[0]?.[0] ?? '';
}

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.mocked(requireFfmpeg).mockResolvedValue(undefined);
  vi.mocked(requireWhisper).mockResolvedValue(MODEL);
  vi.mocked(runWhisper).mockResolvedValue(SEGMENTS);
  downloadsAudio();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('transcribeLocally', () => {
  it('downloads the audio as 16 kHz mono wav, the form whisper reads', async () => {
    await transcribeLocally(VIDEO_ID, {});

    const args = ytDlpArgs();
    expect(args).toContain('-x');
    expect(args[args.indexOf('--audio-format') + 1]).toBe('wav');
    expect(args[args.indexOf('--postprocessor-args') + 1]).toBe('ExtractAudio:-ar 16000 -ac 1');
    expect(args).toContain('--no-playlist');
    expect(vi.mocked(runYtDlp).mock.calls[0]?.[1]).toMatchObject({
      retry: false,
      target: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    });
  });

  it('transcribes in the language asked for, with the configured model', async () => {
    await transcribeLocally(VIDEO_ID, { language: 'fr' });

    expect(runWhisper).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`${VIDEO_ID}.*\\.wav$`)),
      'fr',
      MODEL,
      expect.any(String)
    );
  });

  it('returns the words marked as a local transcription, not as captions', async () => {
    const result = await transcribeLocally(VIDEO_ID, {});

    expect(result).toMatchObject({
      videoId: VIDEO_ID,
      language: 'en',
      source: 'local-asr',
      cached: false,
      transcript: 'hello there general kenobi',
    });
    expect(result.segments).toEqual(SEGMENTS);
  });

  it('keeps the result beside, never over, the video’s captions', async () => {
    await transcribeLocally(VIDEO_ID, {});

    const file = asrPath(VIDEO_ID, 'en');
    expect(file).toMatch(/\.en\.asr\.json$/);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toMatchObject({
      videoId: VIDEO_ID,
      segments: SEGMENTS,
    });
  });

  it('serves a kept transcription without any prerequisite, download or model run', async () => {
    await transcribeLocally(VIDEO_ID, {});
    vi.clearAllMocks();

    const again = await transcribeLocally(VIDEO_ID, {});

    expect(again).toMatchObject({ cached: true, source: 'local-asr' });
    expect(requireFfmpeg).not.toHaveBeenCalled();
    expect(requireWhisper).not.toHaveBeenCalled();
    expect(runYtDlp).not.toHaveBeenCalled();
    expect(runWhisper).not.toHaveBeenCalled();
  });

  it('transcribes again when told to refresh', async () => {
    await transcribeLocally(VIDEO_ID, {});
    vi.clearAllMocks();
    downloadsAudio();
    vi.mocked(requireFfmpeg).mockResolvedValue(undefined);
    vi.mocked(requireWhisper).mockResolvedValue(MODEL);
    vi.mocked(runWhisper).mockResolvedValue(SEGMENTS);

    const again = await transcribeLocally(VIDEO_ID, { refresh: true });

    expect(again.cached).toBe(false);
    expect(runWhisper).toHaveBeenCalledTimes(1);
  });

  it('checks ffmpeg and whisper before spending any network on the audio', async () => {
    vi.mocked(requireWhisper).mockRejectedValue(
      new YouTubeError('WHISPER_MISSING', 'Local transcription requires whisper.cpp.')
    );

    await expect(transcribeLocally(VIDEO_ID, {})).rejects.toMatchObject({
      code: 'WHISPER_MISSING',
    });
    expect(requireFfmpeg).toHaveBeenCalled();
    expect(runYtDlp).not.toHaveBeenCalled();
  });

  it('removes the audio file once it has been read', async () => {
    await transcribeLocally(VIDEO_ID, {});

    expect(existsSync(audioPassedToWhisper())).toBe(false);
  });

  it('works in a folder of its own and removes all of it, including what yt-dlp leaves beside the wav', async () => {
    vi.mocked(runYtDlp).mockImplementation((args: string[]) => {
      const template = args[args.indexOf('-o') + 1] ?? '';
      writeFileSync(template.replace('%(ext)s', 'wav'), 'RIFF');
      // The original download and a partial one, as yt-dlp leaves them on a failed conversion.
      writeFileSync(template.replace('%(ext)s', 'webm'), 'original');
      writeFileSync(template.replace('%(ext)s', 'webm.part'), 'partial');
      return Promise.resolve('');
    });

    await transcribeLocally(VIDEO_ID, {});

    const audio = audioPassedToWhisper();
    expect(existsSync(dirname(audio))).toBe(false);
  });

  it('gives two calls for the same video separate folders, so neither can delete the other’s audio', async () => {
    await Promise.all([transcribeLocally(VIDEO_ID, {}), transcribeLocally(VIDEO_ID, {})]);

    const folders = vi.mocked(runWhisper).mock.calls.map(([audio]) => dirname(audio));
    expect(new Set(folders).size).toBe(2);
  });

  it('removes the audio file when whisper fails, and keeps nothing', async () => {
    vi.mocked(runWhisper).mockRejectedValue(new YouTubeError('YTDLP_FAILED', 'whisper failed'));

    await expect(transcribeLocally(VIDEO_ID, {})).rejects.toMatchObject({ code: 'YTDLP_FAILED' });

    expect(existsSync(audioPassedToWhisper())).toBe(false);
    expect(existsSync(asrPath(VIDEO_ID, 'en'))).toBe(false);
  });

  it('reports a recording with no speech as an error and keeps nothing', async () => {
    vi.mocked(runWhisper).mockResolvedValue([]);

    await expect(transcribeLocally(VIDEO_ID, {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('No speech'),
    });
    expect(existsSync(asrPath(VIDEO_ID, 'en'))).toBe(false);
  });

  it('fails clearly when yt-dlp finished without leaving the audio behind', async () => {
    vi.mocked(runYtDlp).mockResolvedValue('');

    await expect(transcribeLocally(VIDEO_ID, {})).rejects.toMatchObject({ code: 'YTDLP_FAILED' });
    expect(runWhisper).not.toHaveBeenCalled();
  });

  it('refuses a language that is not a language tag, before doing anything', async () => {
    await expect(transcribeLocally(VIDEO_ID, { language: '../x' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(runYtDlp).not.toHaveBeenCalled();
  });
});
