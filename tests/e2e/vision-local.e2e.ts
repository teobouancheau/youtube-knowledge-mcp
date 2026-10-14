import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
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
  type ToolOutcome,
} from './harness.js';
import { probeImage } from '../../src/utils/image-dimensions.js';

/**
 * The tools that look at a video, end to end: the built server, a real MCP client,
 * real yt-dlp-shaped answers from a stand-in, and a real HTTPS stream that real ffmpeg
 * seeks into, decodes and measures.
 *
 * The video is three solid colours of three seconds each, so what every tool should
 * find is known exactly: a frame at 1.5s is red, one at 4.5s blue, one at 7.5s green,
 * and the cuts are at 3s and 6s.
 */

const run = promisify(execFile);
const VIDEO = 'ccccccccccc';
const SECONDS_PER_SCENE = 3;

let server: ServerHandle;
let stream: Server;

async function haveCommand(command: string): Promise<boolean> {
  try {
    await run('which', [command]);
    return true;
  } catch {
    return false;
  }
}

const canRun = (await haveCommand('ffmpeg')) && (await haveCommand('openssl'));

/** An HTTPS file server that honours Range, which is how ffmpeg seeks without downloading it all. */
async function serve(
  file: Buffer,
  key: Buffer,
  cert: Buffer
): Promise<{ server: Server; url: string }> {
  const https = createServer({ key, cert }, (request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    const start = Number(range?.[1] ?? 0);
    const end = range?.[2] ? Number(range[2]) : file.length - 1;
    const body = file.subarray(start, end + 1);

    response.writeHead(range === null ? 200 : 206, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': body.length,
      ...(range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${file.length}` }),
    });
    response.end(body);
  });

  await new Promise<void>((resolveListening) => https.listen(0, '127.0.0.1', resolveListening));
  const { port } = https.address() as AddressInfo;
  return { server: https, url: `https://127.0.0.1:${String(port)}/video.mp4` };
}

function images(outcome: ToolOutcome): { data: string; width: number }[] {
  return outcome.raw.content.flatMap((block) => {
    if (block.type !== 'image') return [];
    const probe = probeImage(Buffer.from(block.data, 'base64'));
    return [{ data: block.data, width: probe?.width ?? 0 }];
  });
}

beforeAll(async () => {
  if (!canRun) return;

  const work = join(tmpdir(), `ykm-vision-${String(process.pid)}`);
  await mkdir(work, { recursive: true });

  const video = join(work, 'video.mp4');
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-filter_complex',
    `color=c=red:s=640x360:r=25:d=${String(SECONDS_PER_SCENE)}[a];` +
      `color=c=blue:s=640x360:r=25:d=${String(SECONDS_PER_SCENE)}[b];` +
      `color=c=green:s=640x360:r=25:d=${String(SECONDS_PER_SCENE)}[c];` +
      '[a][b][c]concat=n=3:v=1:a=0,format=yuv420p',
    '-c:v',
    'libx264',
    '-movflags',
    '+faststart',
    video,
  ]);

  const key = join(work, 'key.pem');
  const cert = join(work, 'cert.pem');
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-keyout',
    key,
    '-out',
    cert,
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);

  const hosted = await serve(await readFile(video), await readFile(key), await readFile(cert));
  stream = hosted.server;

  const shimDir = await installFakeYtDlp(work);
  const rows = join(work, 'rows.json');
  await writeFile(
    rows,
    JSON.stringify({ [VIDEO]: fakeRow(VIDEO, { duration: 3 * SECONDS_PER_SCENE }) })
  );

  server = await startStdioServer({
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      FAKE_ROWS: rows,
      FAKE_STREAM_URL: hosted.url,
      // ffmpeg is built on OpenSSL, which trusts this certificate through this variable.
      SSL_CERT_FILE: cert,
    },
  });
});

afterAll(async () => {
  if (!canRun) return;
  await server.close();
  await removeHome(server.home);
  await new Promise((resolveClosed) => stream.close(resolveClosed));
});

describe.skipIf(!canRun)('looking at a video, over a real stream', () => {
  it('extract_frames returns a different picture for each moment, shrunk to the width asked', async () => {
    const outcome = await callToolOk(server.client, 'extract_frames', {
      video: VIDEO,
      timestamps: ['1.5', '4.5', '7.5'],
      width: 320,
    });

    const shown = images(outcome);
    expect(shown).toHaveLength(3);
    expect(new Set(shown.map((image) => image.data)).size).toBe(3);
    for (const image of shown) expect(image.width).toBe(320);
    expect(outcome.structured).toMatchObject({
      videoId: VIDEO,
      frames: [{ timestampSeconds: 1.5 }, { timestampSeconds: 4.5 }, { timestampSeconds: 7.5 }],
    });
  });

  it('extract_frames never enlarges a frame past what the video has', async () => {
    const outcome = await callToolOk(server.client, 'extract_frames', {
      video: VIDEO,
      count: 1,
      width: 1280,
    });

    expect(images(outcome)[0]?.width).toBe(640);
  });

  it('extract_contact_sheet tiles the video into one image and lists each cell', async () => {
    const outcome = await callToolOk(server.client, 'extract_contact_sheet', {
      video: VIDEO,
      count: 3,
      columns: 3,
    });

    const [sheet, ...rest] = images(outcome);
    expect(rest).toHaveLength(0);
    // Three 320px cells and their margins.
    expect(sheet?.width).toBeGreaterThan(960);
    expect(outcome.structured).toMatchObject({ columns: 3, rows: 1 });
    expect(outcome.structured.cells).toHaveLength(3);
  });

  it('detect_scenes finds the two cuts between the three colours', async () => {
    const outcome = await callToolOk(server.client, 'detect_scenes', {
      video: VIDEO,
      threshold: 0.4,
    });

    const cuts = (outcome.structured.cuts as { timestampSeconds: number }[]).map(
      (cut) => cut.timestampSeconds
    );
    expect(cuts).toHaveLength(2);
    expect(cuts[0]).toBeCloseTo(SECONDS_PER_SCENE, 0);
    expect(cuts[1]).toBeCloseTo(2 * SECONDS_PER_SCENE, 0);
  });

  it('detect_scenes reports an offset window in the video’s own time, not the window’s', async () => {
    const outcome = await callToolOk(server.client, 'detect_scenes', {
      video: VIDEO,
      start: '2',
      end: '9',
      threshold: 0.4,
    });

    const cuts = (outcome.structured.cuts as { timestampSeconds: number }[]).map(
      (cut) => cut.timestampSeconds
    );
    expect(cuts[0]).toBeCloseTo(SECONDS_PER_SCENE, 0);
    expect(outcome.structured).toMatchObject({ windowStart: 2, windowEnd: 9 });
  });

  it('extract_gif makes a looping GIF of the range, no wider than asked', async () => {
    const outcome = await callToolOk(server.client, 'extract_gif', {
      video: VIDEO,
      start: '2',
      end: '5',
      width: 320,
      fps: 8,
    });

    const { filePath, bytes } = outcome.structured as { filePath: string; bytes: number };
    const file = await readFile(filePath);
    expect(file.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(file.byteLength).toBe(bytes);
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width',
      '-of',
      'default=nw=1:nk=1',
      filePath,
    ]);
    expect(Number(stdout)).toBe(320);
    expect(outcome.structured).toMatchObject({ durationSeconds: 3, fps: 8 });
  });

  it('concat_clips joins clips of different sizes into one playable video', async () => {
    const dir = join(server.home, 'clips');
    await mkdir(dir, { recursive: true });
    const first = join(dir, 'first.mp4');
    const second = join(dir, 'second.mp4');
    for (const [file, colour, size] of [
      [first, 'red', '640x360'],
      [second, 'blue', '320x180'],
    ] as const) {
      await run('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${colour}:s=${size}:r=25:d=1`,
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        file,
      ]);
    }

    const outcome = await callToolOk(server.client, 'concat_clips', {
      clips: [first, second],
      name: 'joined',
    });

    const { filePath } = outcome.structured as { filePath: string };
    expect(filePath).toMatch(/joined\.mp4$/);
    expect(outcome.structured).toMatchObject({ clips: 2 });

    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nw=1:nk=1',
      filePath,
    ]);
    expect(Number(stdout)).toBeCloseTo(2, 0);
  });

  it('concat_clips refuses a path outside the home directory, without running ffmpeg', async () => {
    const outcome = await callTool(server.client, 'concat_clips', {
      clips: ['/etc/hosts', '/etc/passwd'],
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('inside your home directory');
  });

  it('extract_frame still writes the picture and now shows it too', async () => {
    const outcome = await callToolOk(server.client, 'extract_frame', {
      video: VIDEO,
      timestamp: '4.5',
      format: 'jpg',
    });

    expect(images(outcome)).toHaveLength(1);
    expect(outcome.raw.content.some((block) => block.type === 'resource_link')).toBe(true);
  });
});
