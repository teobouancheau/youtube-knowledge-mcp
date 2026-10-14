import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fakeRow, installFakeYtDlp } from './fake-ytdlp.js';
import {
  callTool,
  callToolOk,
  removeHome,
  startStdioServer,
  type ServerHandle,
} from './harness.js';

/**
 * The built server, over a real MCP client, with real ffmpeg and real whisper.cpp,
 * and a stand-in for yt-dlp that serves local files instead of YouTube.
 *
 * Everything this lane proves is about this server's own wiring: what it asks yt-dlp
 * for, what it does with the answer, what it keeps and how it reads it back. It does
 * not prove YouTube serves what the stand-in does; the per-video lane does that.
 *
 * Needs `whisper-cli` on PATH and YOUTUBE_MCP_WHISPER_MODEL set, as the feature does.
 */

const run = promisify(execFile);

const SPOKEN = 'Hello. This is a test of the local transcription of a video.';
const SPEECH_VIDEO = 'aaaaaaaaaaa';
const SILENT_VIDEO = 'bbbbbbbbbbb';
const MODEL = process.env.YOUTUBE_MCP_WHISPER_MODEL;

const ROWS = {
  [SPEECH_VIDEO]: fakeRow(SPEECH_VIDEO, {
    title: 'A video with a spoken test',
    channel_id: 'UCaaaaaaaaaaaaaaaaaaaaaa',
    duration: 100,
    view_count: 1234,
    categories: ['Education'],
    license: 'Standard YouTube License',
    language: 'en',
    subtitles: { fr: [{ url: 'x' }] },
    automatic_captions: { 'en-orig': [{ url: 'y' }], en: [{ url: 'y' }], de: [{ url: 'z' }] },
    heatmap: [
      { start_time: 0, end_time: 10, value: 0.2 },
      { start_time: 10, end_time: 20, value: 0.95 },
      { start_time: 20, end_time: 30, value: 0.3 },
      { start_time: 60, end_time: 70, value: 0.7 },
    ],
  }),
  [SILENT_VIDEO]: fakeRow(SILENT_VIDEO, { title: 'A video with nothing said', duration: 5 }),
};

let server: ServerHandle;
let speechWav: string | undefined;

async function haveCommand(command: string): Promise<boolean> {
  try {
    await run('which', [command]);
    return true;
  } catch {
    return false;
  }
}

const hasWhisper = MODEL !== undefined && (await haveCommand('whisper-cli'));
const canSpeak = hasWhisper && (await haveCommand('say'));

beforeAll(async () => {
  if (!hasWhisper) return;

  const work = join(tmpdir(), `ykm-local-${String(process.pid)}`);
  await mkdir(work, { recursive: true });

  const silentWav = join(work, 'silent.wav');
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=16000:cl=mono',
    '-t',
    '3',
    silentWav,
  ]);

  if (canSpeak) {
    const aiff = join(work, 'speech.aiff');
    speechWav = join(work, 'speech.wav');
    await run('say', ['-o', aiff, SPOKEN]);
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      aiff,
      '-ar',
      '16000',
      '-ac',
      '1',
      speechWav,
    ]);
  }

  const shimDir = await installFakeYtDlp(work);
  const rows = join(work, 'rows.json');
  await writeFile(rows, JSON.stringify(ROWS));

  server = await startStdioServer({
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      YOUTUBE_MCP_WHISPER_MODEL: MODEL,
      FAKE_ROWS: rows,
      [`FAKE_AUDIO_${SPEECH_VIDEO}`]: speechWav ?? silentWav,
      [`FAKE_AUDIO_${SILENT_VIDEO}`]: silentWav,
    },
  });
});

afterAll(async () => {
  if (!hasWhisper) return;
  await server.close();
  await removeHome(server.home);
});

describe.skipIf(!hasWhisper)('local tools, with a stand-in for yt-dlp', () => {
  it('check_health reports whisper ready without exposing the model path', async () => {
    const { structured } = await callToolOk(server.client, 'check_health');

    expect(structured.whisper).toMatchObject({
      installed: true,
      modelConfigured: true,
      modelFound: true,
    });
    expect(JSON.stringify(structured)).not.toContain(MODEL ?? '\0');
  });

  it('get_video_details reports the replay peaks, licence and caption inventory', async () => {
    const { structured } = await callToolOk(server.client, 'get_video_details', {
      video: SPEECH_VIDEO,
    });

    expect(structured).toMatchObject({
      videoId: SPEECH_VIDEO,
      license: 'Standard YouTube License',
      language: 'en',
      categories: ['Education'],
    });
    const peaks = structured.mostReplayed as { timestampSeconds: number; value: number }[];
    expect(peaks.map((peak) => peak.timestampSeconds)).toEqual([10, 60]);
  });

  it('list_captions splits human and automatic captions and names the spoken language', async () => {
    const { structured } = await callToolOk(server.client, 'list_captions', {
      video: SPEECH_VIDEO,
    });

    expect(structured).toMatchObject({
      hasCaptions: true,
      manual: ['fr'],
      automatic: ['de', 'en'],
      spokenLanguage: 'en',
    });
  });

  it('a video with no captions fails with NO_CAPTIONS until it is transcribed', async () => {
    const outcome = await callTool(server.client, 'get_transcript', { video: SILENT_VIDEO });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('NO_CAPTIONS');
  });

  it('transcribe_video refuses a recording with no speech, and keeps nothing', async () => {
    const outcome = await callTool(server.client, 'transcribe_video', {
      video: SILENT_VIDEO,
      language: 'en',
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('No speech');
    const after = await callTool(server.client, 'get_transcript', { video: SILENT_VIDEO });
    expect(after.text).toContain('NO_CAPTIONS');
  });

  it.skipIf(!canSpeak)(
    'transcribe_video hears the speech, and the transcript is then read like captions',
    async () => {
      const made = await callToolOk(server.client, 'transcribe_video', {
        video: SPEECH_VIDEO,
        language: 'en',
      });
      expect(made.structured).toMatchObject({
        videoId: SPEECH_VIDEO,
        source: 'local-asr',
        cached: false,
      });
      expect(made.structured.segmentCount).toBeGreaterThan(0);

      const read = await callToolOk(server.client, 'get_transcript', { video: SPEECH_VIDEO });
      expect(read.structured).toMatchObject({ source: 'local-asr', cached: true });
      expect(read.text).toContain('transcribed locally');

      const heard = String(read.structured.text)
        .split(/\W+/)
        .find((word) => word.length > 3);
      expect(heard).toBeDefined();
      const found = await callToolOk(server.client, 'search_transcript', {
        video: SPEECH_VIDEO,
        query: heard,
      });
      expect(found.structured.matchCount).toBeGreaterThan(0);

      const again = await callToolOk(server.client, 'transcribe_video', {
        video: SPEECH_VIDEO,
        language: 'en',
      });
      expect(again.structured).toMatchObject({ cached: true });
    }
  );
});
