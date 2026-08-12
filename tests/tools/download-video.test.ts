import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/youtube.js', () => ({
  listFormats: vi.fn(),
  downloadVideo: vi.fn(),
}));

import { listFormats, downloadVideo } from '../../src/utils/youtube.js';
import { listFormatsHandler, downloadVideoHandler } from '../../src/tools/download-video.js';

const COMBINED = {
  formatId: '18',
  ext: 'mp4',
  resolution: '640x360',
  fps: 30,
  vcodec: 'avc1',
  acodec: 'mp4a',
  filesize: 5 * 1024 * 1024,
  note: '',
};
const VIDEO_ONLY = {
  formatId: '137',
  ext: 'mp4',
  resolution: '1920x1080',
  fps: 60,
  vcodec: 'avc1',
  acodec: 'none',
  filesize: 100 * 1024 * 1024,
  note: '',
};
const AUDIO_ONLY = {
  formatId: '140',
  ext: 'm4a',
  resolution: 'audio only',
  vcodec: 'none',
  acodec: 'mp4a',
  filesize: 3 * 1024 * 1024,
  note: '',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listFormatsHandler', () => {
  it('groups formats by what they contain', async () => {
    vi.mocked(listFormats).mockResolvedValue([COMBINED, VIDEO_ONLY, AUDIO_ONLY]);

    const text = textOf(await listFormatsHandler({ video: 'v' }));

    expect(text).toContain('video + audio:');
    expect(text).toContain('video only:');
    expect(text).toContain('audio only:');
  });

  it('labels each format with its kind in structured output', async () => {
    vi.mocked(listFormats).mockResolvedValue([COMBINED, VIDEO_ONLY, AUDIO_ONLY]);

    expect(structuredOf(await listFormatsHandler({ video: 'v' }))).toMatchObject({
      count: 3,
      formats: [
        { formatId: '18', kind: 'video+audio', filesizeBytes: 5 * 1024 * 1024 },
        { formatId: '137', kind: 'video-only' },
        { formatId: '140', kind: 'audio-only' },
      ],
    });
  });

  it('omits the size rather than reporting zero when yt-dlp gives none', async () => {
    vi.mocked(listFormats).mockResolvedValue([{ ...COMBINED, filesize: undefined }]);

    const structured = structuredOf(await listFormatsHandler({ video: 'v' }));
    const [format] = structured.formats as Record<string, unknown>[];

    expect(format).not.toHaveProperty('filesizeBytes');
    expect(textOf(await listFormatsHandler({ video: 'v' }))).toContain('Unknown');
  });

  it('explains how to combine streams when no single format has both', async () => {
    vi.mocked(listFormats).mockResolvedValue([VIDEO_ONLY, AUDIO_ONLY]);

    expect(textOf(await listFormatsHandler({ video: 'v' }))).toContain('137+140');
  });

  it('shows the frame rate only when yt-dlp reports one', async () => {
    vi.mocked(listFormats).mockResolvedValue([{ ...COMBINED, fps: undefined }]);

    expect(textOf(await listFormatsHandler({ video: 'v' }))).not.toContain('fps');
  });

  it('handles a video with no formats at all', async () => {
    vi.mocked(listFormats).mockResolvedValue([]);

    expect(structuredOf(await listFormatsHandler({ video: 'v' }))).toMatchObject({ count: 0 });
  });
});

describe('downloadVideoHandler', () => {
  beforeEach(() => {
    vi.mocked(downloadVideo).mockResolvedValue({
      videoId: 'dQw4w9WgXcQ',
      title: 'A Talk',
      filePath: '/home/u/Downloads/A Talk.mp4',
      format: 'best',
    });
  });

  it('reports what was downloaded and where', async () => {
    const result = await downloadVideoHandler({ video: 'v' });

    expect(textOf(result)).toContain('✓ Downloaded');
    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      filePath: '/home/u/Downloads/A Talk.mp4',
    });
  });

  it('attaches the file as a resource link', async () => {
    const result = await downloadVideoHandler({ video: 'v' });
    const link = result.content.find((block) => block.type === 'resource_link');

    expect(link).toMatchObject({ mimeType: 'video/mp4' });
  });

  it('defaults to best quality when neither quality nor formatId is given', async () => {
    await downloadVideoHandler({ video: 'v' });

    expect(downloadVideo).toHaveBeenCalledWith('v', 'best', undefined, 'best');
  });

  it('lets an explicit formatId select the stream, with no quality preset', async () => {
    // Otherwise the default preset would silently override the caller's choice.
    await downloadVideoHandler({ video: 'v', formatId: '137+140' });

    expect(downloadVideo).toHaveBeenCalledWith('v', '137+140', undefined, undefined);
  });

  it('gives an explicit quality precedence over formatId', async () => {
    await downloadVideoHandler({ video: 'v', quality: '720p', formatId: '137' });

    expect(downloadVideo).toHaveBeenCalledWith('v', '137', undefined, '720p');
  });

  it('passes the output directory through', async () => {
    await downloadVideoHandler({ video: 'v', outputDir: '~/Videos' });

    expect(downloadVideo).toHaveBeenCalledWith('v', 'best', '~/Videos', 'best');
  });

  it('names the preset when one was asked for, and the resolved format otherwise', async () => {
    expect(textOf(await downloadVideoHandler({ video: 'v', quality: '720p' }))).toContain(
      'quality: 720p'
    );
    expect(textOf(await downloadVideoHandler({ video: 'v' }))).toContain('format: best');
  });
});
