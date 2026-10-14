import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/store.js')>()),
  getStore: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../src/utils/upload-check.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/upload-check.js')>()),
  checkNewUploads: vi.fn(),
}));

import { checkNewUploads, type UploadCheck } from '../../src/utils/upload-check.js';
import { checkNewUploadsHandler } from '../../src/tools/check-new-uploads.js';

const CHECK: UploadCheck = {
  channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Example',
  handle: '@example',
  lookback: 30,
  checked: [
    { tab: 'videos', listed: 30 },
    { tab: 'shorts', listed: 12 },
  ],
  newVideos: [
    {
      videoId: 'new1',
      title: 'A fresh upload',
      tab: 'videos',
      url: 'https://www.youtube.com/watch?v=new1',
      durationSeconds: 90,
    },
  ],
  catalogHarvestedAt: '2026-10-01T10:00:00.000Z',
  catalogComplete: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkNewUploads).mockResolvedValue(CHECK);
});

describe('checkNewUploadsHandler', () => {
  it('forwards the channel and how far back to look', async () => {
    await checkNewUploadsHandler({ channel: '@example', lookback: 12 });

    expect(checkNewUploads).toHaveBeenCalledWith(expect.anything(), '@example', { lookback: 12 });
  });

  it('lists what is new with its link, and says how to add it', async () => {
    const result = await checkNewUploadsHandler({ channel: '@example', lookback: 30 });

    const text = textOf(result);
    expect(text).toContain('1 new video');
    expect(text).toContain('A fresh upload');
    expect(text).toContain('https://www.youtube.com/watch?v=new1');
    expect(text).toContain('harvest_channel');
    expect(structuredOf(result)).toMatchObject({
      channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
      newCount: 1,
      newVideos: [{ videoId: 'new1', tab: 'videos' }],
    });
  });

  it('says plainly that nothing is new, and against which catalogue', async () => {
    vi.mocked(checkNewUploads).mockResolvedValue({ ...CHECK, newVideos: [] });

    const result = await checkNewUploadsHandler({ channel: '@example', lookback: 30 });

    expect(textOf(result)).toContain('Nothing new');
    expect(textOf(result)).toContain('2026-10-01');
    expect(textOf(result)).not.toContain('harvest_channel');
  });

  it('warns that "nothing new" means less when the catalogue was never whole', async () => {
    vi.mocked(checkNewUploads).mockResolvedValue({
      ...CHECK,
      newVideos: [],
      catalogComplete: false,
    });

    const result = await checkNewUploadsHandler({ channel: '@example', lookback: 30 });

    expect(textOf(result)).toContain('not complete');
  });

  it('names a tab it could not check', async () => {
    vi.mocked(checkNewUploads).mockResolvedValue({
      ...CHECK,
      checked: [
        { tab: 'videos', listed: 30 },
        { tab: 'shorts', listed: 0, error: 'Slow down.' },
      ],
    });

    const result = await checkNewUploadsHandler({ channel: '@example', lookback: 30 });

    expect(textOf(result)).toContain('shorts: could not be checked (Slow down.)');
  });
});
