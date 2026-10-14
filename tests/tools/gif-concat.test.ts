import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/gif.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/gif.js')>()),
  extractGif: vi.fn(),
}));
vi.mock('../../src/utils/concat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/concat.js')>()),
  concatClips: vi.fn(),
}));

import { extractGif } from '../../src/utils/gif.js';
import { concatClips } from '../../src/utils/concat.js';
import { concatClipsHandler, extractGifHandler } from '../../src/tools/gif-concat.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(extractGif).mockResolvedValue({
    videoId: 'dQw4w9WgXcQ',
    title: 'A Talk',
    filePath: '/home/u/.youtube-knowledge/gifs/A Talk [10-14].gif',
    start: 10,
    end: 14,
    duration: 4,
    width: 480,
    fps: 12,
    bytes: 2_500_000,
  });
  vi.mocked(concatClips).mockResolvedValue({
    filePath: '/home/u/.youtube-knowledge/montages/montage-abc12345.mp4',
    clips: 2,
    bytes: 9_000_000,
  });
});

describe('extractGifHandler', () => {
  const args = { video: 'v', width: 480, fps: 12 };

  it('parses the range and forwards the size and rate', async () => {
    await extractGifHandler({ ...args, start: '0:10', end: '0:14', width: 320, fps: 8 });

    expect(extractGif).toHaveBeenCalledWith(
      'v',
      { start: 10, end: 14, chapter: undefined },
      expect.objectContaining({ width: 320, fps: 8 })
    );
  });

  it('reports the file and what is in it, and links to it as a GIF', async () => {
    const result = await extractGifHandler({ ...args, start: '10', end: '14' });

    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      filePath: '/home/u/.youtube-knowledge/gifs/A Talk [10-14].gif',
      startSeconds: 10,
      endSeconds: 14,
      durationSeconds: 4,
      width: 480,
      fps: 12,
      bytes: 2_500_000,
    });
    expect(textOf(result)).toContain('GIF');
    expect(textOf(result)).toContain('2.4 MB');
    expect(result.content.find((block) => block.type === 'resource_link')).toMatchObject({
      mimeType: 'image/gif',
    });
  });

  it('rejects an unparseable timestamp before touching the network', async () => {
    await expect(extractGifHandler({ ...args, start: 'later', end: '14' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(extractGif).not.toHaveBeenCalled();
  });
});

describe('concatClipsHandler', () => {
  const clips = ['/home/u/a.mp4', '/home/u/b.mp4'];

  it('forwards the files in order, the name and the folder', async () => {
    await concatClipsHandler({ clips, name: 'highlights', outputDir: '~/Videos' });

    expect(concatClips).toHaveBeenCalledWith(clips, { name: 'highlights', outputDir: '~/Videos' });
  });

  it('reports the joined file and links to it as a video', async () => {
    const result = await concatClipsHandler({ clips });

    expect(structuredOf(result)).toMatchObject({
      filePath: '/home/u/.youtube-knowledge/montages/montage-abc12345.mp4',
      clips: 2,
      bytes: 9_000_000,
    });
    expect(textOf(result)).toContain('2 clips');
    expect(result.content.find((block) => block.type === 'resource_link')).toMatchObject({
      mimeType: 'video/mp4',
    });
  });
});
