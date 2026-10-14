import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/frames.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/frames.js')>()),
  captureFrames: vi.fn(),
}));
vi.mock('../../src/utils/contact-sheet.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/contact-sheet.js')>()),
  captureContactSheet: vi.fn(),
}));
vi.mock('../../src/utils/scenes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/scenes.js')>()),
  detectScenes: vi.fn(),
}));

import { captureFrames } from '../../src/utils/frames.js';
import { captureContactSheet } from '../../src/utils/contact-sheet.js';
import { detectScenes } from '../../src/utils/scenes.js';
import { contactSheetHandler, extractFramesHandler } from '../../src/tools/frames.js';
import { detectScenesHandler } from '../../src/tools/detect-scenes.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractFramesHandler', () => {
  const args = { video: 'v', width: 768 };

  beforeEach(() => {
    vi.mocked(captureFrames).mockResolvedValue({
      videoId: 'dQw4w9WgXcQ',
      title: 'A Talk',
      duration: 600,
      frames: [
        { timestamp: 90, bytes: JPEG },
        { timestamp: 200, bytes: JPEG },
      ],
    });
  });

  it('parses clock timestamps before capturing anything', async () => {
    await extractFramesHandler({ ...args, timestamps: ['1:30', '200'] });

    expect(captureFrames).toHaveBeenCalledWith(
      'v',
      expect.objectContaining({ timestamps: [90, 200] }),
      expect.objectContaining({ width: 768 })
    );
  });

  it('forwards a count and a window', async () => {
    await extractFramesHandler({ ...args, count: 4, start: '1:00', end: '2:00' });

    expect(captureFrames).toHaveBeenCalledWith(
      'v',
      expect.objectContaining({ count: 4, start: 60, end: 120 }),
      expect.anything()
    );
  });

  it('returns each picture as an image block, labelled with when it was taken', async () => {
    const result = await extractFramesHandler({ ...args, count: 2 });

    const images = result.content.filter((block) => block.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ mimeType: 'image/jpeg', data: JPEG.toString('base64') });
    // Each image is preceded by the text that says which moment it shows.
    const order = result.content.map((block) => block.type);
    expect(order.slice(1)).toEqual(['text', 'image', 'text', 'image']);
    expect(textOf(result)).toContain('A Talk');
  });

  it('reports every moment with a link that opens the video there', async () => {
    const result = await extractFramesHandler({ ...args, count: 2 });

    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      width: 768,
      frames: [
        {
          timestampSeconds: 90,
          timestamp: '1:30',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s',
        },
        { timestampSeconds: 200, timestamp: '3:20' },
      ],
    });
  });

  it('rejects an unparseable timestamp before touching the network', async () => {
    await expect(extractFramesHandler({ ...args, timestamps: ['later'] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(captureFrames).not.toHaveBeenCalled();
  });
});

describe('contactSheetHandler', () => {
  beforeEach(() => {
    vi.mocked(captureContactSheet).mockResolvedValue({
      videoId: 'dQw4w9WgXcQ',
      title: 'A Talk',
      duration: 600,
      bytes: JPEG,
      columns: 2,
      rows: 2,
      timestamps: [10, 20, 30, 40],
    });
  });

  it('forwards the request and the grid width', async () => {
    await contactSheetHandler({ video: 'v', count: 4, columns: 2, start: '0:30' });

    expect(captureContactSheet).toHaveBeenCalledWith(
      'v',
      expect.objectContaining({ count: 4, start: 30 }),
      2
    );
  });

  it('returns one image and says which moment each cell shows, row by row', async () => {
    const result = await contactSheetHandler({ video: 'v', count: 4, columns: 2 });

    expect(result.content.filter((block) => block.type === 'image')).toHaveLength(1);
    const text = textOf(result);
    expect(text).toContain('Row 1: 0:10, 0:20');
    expect(text).toContain('Row 2: 0:30, 0:40');
  });

  it('lists the cells in reading order with their links', async () => {
    const result = await contactSheetHandler({ video: 'v', count: 4, columns: 2 });

    expect(structuredOf(result)).toMatchObject({
      columns: 2,
      rows: 2,
      mimeType: 'image/jpeg',
      cells: [{ timestampSeconds: 10 }, { timestampSeconds: 20 }, {}, { timestampSeconds: 40 }],
    });
  });
});

describe('detectScenesHandler', () => {
  beforeEach(() => {
    vi.mocked(detectScenes).mockResolvedValue({
      videoId: 'dQw4w9WgXcQ',
      title: 'A Talk',
      duration: 600,
      start: 0,
      end: 600,
      threshold: 0.4,
      cuts: [12.5, 61],
      truncated: false,
    });
  });

  it('parses the window and forwards the threshold', async () => {
    await detectScenesHandler({ video: 'v', start: '1:00', end: '2:00', threshold: 0.3 });

    expect(detectScenes).toHaveBeenCalledWith('v', { start: 60, end: 120, threshold: 0.3 });
  });

  it('lists every cut with a link and says where the scan looked', async () => {
    const result = await detectScenesHandler({ video: 'v', threshold: 0.4 });

    expect(textOf(result)).toContain('2 scene cuts');
    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      windowStart: 0,
      windowEnd: 600,
      threshold: 0.4,
      truncated: false,
      cuts: [{ timestampSeconds: 12.5 }, { timestampSeconds: 61, timestamp: '1:01' }],
    });
  });

  it('tells the caller how to see fewer cuts when the list was cut short', async () => {
    vi.mocked(detectScenes).mockResolvedValue({
      videoId: 'v',
      title: 'T',
      duration: 600,
      start: 0,
      end: 600,
      threshold: 0.2,
      cuts: [1, 2],
      truncated: true,
    });

    const result = await detectScenesHandler({ video: 'v', threshold: 0.2 });

    expect(textOf(result)).toContain('Raise the threshold');
    expect(structuredOf(result)).toMatchObject({ truncated: true });
  });

  it('says so plainly when nothing cuts', async () => {
    vi.mocked(detectScenes).mockResolvedValue({
      videoId: 'v',
      title: 'T',
      duration: 600,
      start: 0,
      end: 600,
      threshold: 0.4,
      cuts: [],
      truncated: false,
    });

    const result = await detectScenesHandler({ video: 'v', threshold: 0.4 });

    expect(textOf(result)).toContain('No scene cuts');
    expect(textOf(result)).toContain('Lower the threshold');
  });
});
