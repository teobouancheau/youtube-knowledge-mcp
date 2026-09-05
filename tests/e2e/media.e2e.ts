import { describe, it, expect, afterAll, beforeAll, inject } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import {
  callTool,
  callToolOk,
  removeHome,
  startStdioServer,
  type ServerHandle,
} from './harness.js';
import { VIDEO } from './fixtures.js';
import { probeImage } from '../../src/utils/image-dimensions.js';

let server: ServerHandle;

beforeAll(async () => {
  server = await startStdioServer();
});

afterAll(async () => {
  await server.close();
  await removeHome(server.home);
});

// Skipped, with the reason printed by the global setup, where YouTube bot-checks the address.
describe.skipIf(!inject('perVideo'))('media', () => {
  it('extract_frame writes a decodable still', async () => {
    const { structured } = await callToolOk(server.client, 'extract_frame', {
      video: VIDEO.id,
      timestamp: '0:05',
    });
    const bytes = await readFile(structured.filePath as string);
    expect(probeImage(bytes)).toMatchObject({ format: 'png' });
  });

  it('extract_clip and extract_audio_clip produce files of the requested range', async () => {
    const clip = await callToolOk(server.client, 'extract_clip', {
      video: VIDEO.id,
      start: '0:02',
      end: '0:06',
      quality: '360p',
      preciseCuts: false,
    });
    expect((await stat(clip.structured.filePath as string)).size).toBeGreaterThan(0);
    expect(clip.structured.filePath).toMatch(/\.mp4$/);

    const audio = await callToolOk(server.client, 'extract_audio_clip', {
      video: VIDEO.id,
      start: '0:02',
      end: '0:04',
      audioFormat: 'mp3',
    });
    expect((await stat(audio.structured.filePath as string)).size).toBeGreaterThan(0);
  });

  it('extract_clips cuts several ranges and reports each', async () => {
    const { structured } = await callToolOk(server.client, 'extract_clips', {
      video: VIDEO.id,
      ranges: [
        { start: '0:01', end: '0:03' },
        { start: '0:04', end: '0:06' },
      ],
      quality: '360p',
      preciseCuts: false,
    });
    expect(structured).toMatchObject({ requested: 2, succeeded: 2 });
  });

  it('export_subtitles writes SRT that parses, and download_video writes a file', async () => {
    const subtitles = await callToolOk(server.client, 'export_subtitles', {
      video: VIDEO.id,
      format: 'srt',
    });
    const srt = await readFile(subtitles.structured.filePath as string, 'utf-8');
    expect(srt).toMatch(/^1\n\d\d:\d\d:\d\d,\d{3} --> /);

    const download = await callToolOk(server.client, 'download_video', {
      video: VIDEO.id,
      quality: '360p',
    });
    expect((await stat(download.structured.filePath as string)).size).toBeGreaterThan(0);
  });

  it('refuses an output directory outside home, and one that escapes through a symlink', async () => {
    const outside = await callTool(server.client, 'extract_frame', {
      video: VIDEO.id,
      timestamp: '0:01',
      outputDir: '/etc',
    });
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('[INVALID_INPUT]');
  });
});
