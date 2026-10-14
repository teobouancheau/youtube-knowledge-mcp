import { describe, it, expect, afterAll, beforeAll, inject } from 'vitest';
import {
  callToolOk,
  removeHome,
  startStdioServer,
  type ServerHandle,
  type ToolOutcome,
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

/** Every image block of a result, decoded and measured. */
function decodedImages(outcome: ToolOutcome): ReturnType<typeof probeImage>[] {
  return outcome.raw.content.flatMap((block) =>
    block.type === 'image' ? [probeImage(Buffer.from(block.data, 'base64'))] : []
  );
}

// Skipped, with the reason printed by the global setup, where YouTube bot-checks the address.
describe.skipIf(!inject('perVideo'))('vision', () => {
  it('extract_frames returns decodable pictures at the requested moments', async () => {
    const outcome = await callToolOk(server.client, 'extract_frames', {
      video: VIDEO.id,
      timestamps: ['0:05', '0:30'],
      width: 480,
    });

    const images = decodedImages(outcome);
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image).toMatchObject({ format: 'jpeg', width: expect.any(Number) });
      expect(image?.width).toBeLessThanOrEqual(480);
    }
    expect(outcome.structured).toMatchObject({
      videoId: VIDEO.id,
      frames: [{ timestampSeconds: 5 }, { timestampSeconds: 30 }],
    });
  });

  it('extract_frames spreads a count of frames across the video', async () => {
    const outcome = await callToolOk(server.client, 'extract_frames', {
      video: VIDEO.id,
      count: 3,
    });

    expect(decodedImages(outcome)).toHaveLength(3);
  });

  it('extract_contact_sheet returns one image wider than a single cell', async () => {
    const outcome = await callToolOk(server.client, 'extract_contact_sheet', {
      video: VIDEO.id,
      count: 8,
      columns: 4,
    });

    const [sheet, ...rest] = decodedImages(outcome);
    expect(rest).toHaveLength(0);
    expect(sheet?.width).toBeGreaterThan(320 * 3);
    expect(outcome.structured).toMatchObject({ columns: 4, rows: 2 });
    expect(outcome.structured.cells).toHaveLength(8);
  });

  it('detect_scenes reports cuts inside the video it scanned', async () => {
    const outcome = await callToolOk(server.client, 'detect_scenes', {
      video: VIDEO.id,
      threshold: 0.3,
    });

    const { cuts, windowStart, windowEnd } = outcome.structured as {
      cuts: { timestampSeconds: number }[];
      windowStart: number;
      windowEnd: number;
    };
    expect(windowStart).toBe(0);
    expect(windowEnd).toBeGreaterThan(0);
    for (const cut of cuts) {
      expect(cut.timestampSeconds).toBeGreaterThanOrEqual(windowStart);
      expect(cut.timestampSeconds).toBeLessThanOrEqual(windowEnd);
    }
  });

  it('extract_frame also shows the model the picture it saved', async () => {
    const outcome = await callToolOk(server.client, 'extract_frame', {
      video: VIDEO.id,
      timestamp: '0:05',
      format: 'jpg',
    });

    expect(decodedImages(outcome)).toHaveLength(1);
  });
});
