import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn(), ExecaError: class extends Error {} }));
vi.mock('node:fs/promises', () => ({ stat: vi.fn(), readFile: vi.fn(), rm: vi.fn() }));

import { execa } from 'execa';
import { readFile, rm, stat } from 'node:fs/promises';
import {
  WHISPER_BINARY,
  parseWhisperJson,
  probeWhisper,
  requireWhisper,
  runWhisper,
  whisperLanguage,
} from '../../src/utils/whisper.js';

const MODEL = '/models/ggml-base.bin';

/** What whisper.cpp 1.9.5 writes with -oj, trimmed to the fields that are read. */
const OUTPUT = JSON.stringify({
  result: { language: 'en' },
  transcription: [
    { offsets: { from: 0, to: 2500 }, text: ' Hello there.' },
    { offsets: { from: 2500, to: 4000 }, text: ' [BLANK_AUDIO]' },
    { offsets: { from: 4000, to: 6250 }, text: ' General Kenobi.' },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('YOUTUBE_MCP_WHISPER_MODEL', MODEL);
  vi.mocked(execa).mockResolvedValue({ stdout: 'whisper.cpp version: 1.9.5' } as never);
  vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseWhisperJson', () => {
  it('turns millisecond offsets into seconds and trims whisper’s leading space', () => {
    expect(parseWhisperJson(OUTPUT)[0]).toEqual({ start: 0, end: 2.5, text: 'Hello there.' });
  });

  it('drops the silence marker whisper writes for stretches with no speech', () => {
    const texts = parseWhisperJson(OUTPUT).map((segment) => segment.text);

    expect(texts).toEqual(['Hello there.', 'General Kenobi.']);
  });

  it('keeps the timing of the segments that remain', () => {
    expect(parseWhisperJson(OUTPUT)[1]).toEqual({ start: 4, end: 6.25, text: 'General Kenobi.' });
  });

  it('returns nothing for a recording with no speech at all', () => {
    expect(parseWhisperJson(JSON.stringify({ transcription: [] }))).toEqual([]);
  });

  it('refuses output that is not JSON, as a malformed response', () => {
    expect(() => parseWhisperJson('not json')).toThrow(
      expect.objectContaining({ code: 'MALFORMED_RESPONSE' })
    );
  });

  it('refuses output that is JSON but not a transcription', () => {
    expect(() => parseWhisperJson(JSON.stringify({ transcription: 'oops' }))).toThrow(
      expect.objectContaining({ code: 'MALFORMED_RESPONSE' })
    );
  });
});

describe('probeWhisper', () => {
  it('reports the version, and the model when it is configured and there', async () => {
    expect(await probeWhisper()).toEqual({
      installed: true,
      version: '1.9.5',
      modelPath: MODEL,
      modelFound: true,
    });
    expect(execa).toHaveBeenCalledWith(WHISPER_BINARY, ['--version'], expect.anything());
  });

  it('says it is not installed when the binary cannot be started', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('ENOENT'));

    expect(await probeWhisper()).toMatchObject({ installed: false });
  });

  it('calls a version it cannot read unknown, and still counts it installed', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'something else' } as never);

    expect(await probeWhisper()).toMatchObject({ installed: true, version: 'unknown' });
  });

  it('reports no model when none is configured', async () => {
    vi.stubEnv('YOUTUBE_MCP_WHISPER_MODEL', '');

    const status = await probeWhisper();

    expect(status.modelPath).toBeUndefined();
    expect(status.modelFound).toBe(false);
  });

  it('reports a configured model that is not on disk as missing', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

    expect(await probeWhisper()).toMatchObject({ modelPath: MODEL, modelFound: false });
  });

  it('does not count a directory as a model', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => false } as never);

    expect(await probeWhisper()).toMatchObject({ modelFound: false });
  });
});

describe('requireWhisper', () => {
  it('returns the model path when everything is in place', async () => {
    expect(await requireWhisper('Local transcription')).toBe(MODEL);
  });

  it('says how to install whisper.cpp when the binary is missing', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('ENOENT'));

    await expect(requireWhisper('Local transcription')).rejects.toMatchObject({
      code: 'WHISPER_MISSING',
      message: expect.stringContaining('Local transcription requires whisper.cpp'),
      nextStep: expect.stringContaining('whisper.cpp'),
    });
  });

  it('says which setting to set when no model is configured', async () => {
    vi.stubEnv('YOUTUBE_MCP_WHISPER_MODEL', '');

    await expect(requireWhisper('Local transcription')).rejects.toMatchObject({
      code: 'WHISPER_MISSING',
      nextStep: expect.stringContaining('YOUTUBE_MCP_WHISPER_MODEL'),
    });
  });

  it('names the path when the configured model is not there', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

    await expect(requireWhisper('Local transcription')).rejects.toMatchObject({
      code: 'WHISPER_MISSING',
      message: expect.stringContaining(MODEL),
    });
  });
});

describe('whisperLanguage', () => {
  it.each([
    ['en', 'en'],
    ['pt-BR', 'pt'],
    ['zh-Hans', 'zh'],
    ['EN', 'en'],
  ])('names %s as %s, the form whisper.cpp accepts', (tag, expected) => {
    expect(whisperLanguage(tag)).toBe(expected);
  });
});

describe('runWhisper', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockResolvedValue(OUTPUT);
    vi.mocked(rm).mockResolvedValue(undefined);
  });

  function argv(): string[] {
    const args = vi.mocked(execa).mock.calls[0]?.[1];
    return Array.isArray(args) ? args.map(String) : [];
  }

  it('runs the model over the audio in the language asked for, writing JSON', async () => {
    await runWhisper('/tmp/a.wav', 'fr', MODEL, '/tmp/out');

    const args = argv();
    expect(args[args.indexOf('-m') + 1]).toBe(MODEL);
    expect(args[args.indexOf('-f') + 1]).toBe('/tmp/a.wav');
    // An explicit language: auto-detection mistook English for French on a small model.
    expect(args[args.indexOf('-l') + 1]).toBe('fr');
  });

  it('gives whisper the primary subtag of a regional tag, which it would otherwise refuse', async () => {
    await runWhisper('/tmp/a.wav', 'pt-BR', MODEL, '/tmp/out');

    const args = argv();
    expect(args[args.indexOf('-l') + 1]).toBe('pt');
    expect(args).toContain('-oj');
    expect(args[args.indexOf('-of') + 1]).toBe('/tmp/out');
  });

  it('returns the segments from the JSON file it wrote, then removes the file', async () => {
    const segments = await runWhisper('/tmp/a.wav', 'en', MODEL, '/tmp/out');

    expect(readFile).toHaveBeenCalledWith('/tmp/out.json', 'utf-8');
    expect(segments.map((segment) => segment.text)).toEqual(['Hello there.', 'General Kenobi.']);
    expect(rm).toHaveBeenCalledWith('/tmp/out.json', { force: true });
  });

  it('removes the JSON file even when it cannot be parsed', async () => {
    vi.mocked(readFile).mockResolvedValue('garbage');

    await expect(runWhisper('/tmp/a.wav', 'en', MODEL, '/tmp/out')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
    expect(rm).toHaveBeenCalledWith('/tmp/out.json', { force: true });
  });

  it('wraps a whisper failure and keeps the cause', async () => {
    const cause = new Error('segfault');
    vi.mocked(execa).mockRejectedValue(cause);

    await expect(runWhisper('/tmp/a.wav', 'en', MODEL, '/tmp/out')).rejects.toMatchObject({
      code: 'YTDLP_FAILED',
      message: expect.stringContaining('whisper'),
      cause,
    });
  });
});
