import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/sponsorblock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/sponsorblock.js')>()),
  fetchSponsorSegments: vi.fn(),
}));

import { fetchSponsorSegments } from '../../src/utils/sponsorblock.js';
import { getSponsorSegmentsHandler } from '../../src/tools/get-sponsor-segments.js';

const VIDEO = 'dQw4w9WgXcQ';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchSponsorSegments).mockResolvedValue([
    { category: 'intro', startSeconds: 0, endSeconds: 10, durationSeconds: 10, votes: 4 },
    { category: 'sponsor', startSeconds: 61, endSeconds: 91.5, durationSeconds: 30.5, votes: 9 },
  ]);
});

describe('getSponsorSegmentsHandler', () => {
  it('asks for the video id it was given, however it was written', async () => {
    await getSponsorSegmentsHandler({ video: `https://www.youtube.com/watch?v=${VIDEO}` });

    expect(fetchSponsorSegments).toHaveBeenCalledWith(VIDEO, undefined);
  });

  it('forwards the categories asked for', async () => {
    await getSponsorSegmentsHandler({ video: VIDEO, categories: ['sponsor'] });

    expect(fetchSponsorSegments).toHaveBeenCalledWith(VIDEO, ['sponsor']);
  });

  it('lists each segment with when it starts and a link that opens the video there', async () => {
    const result = await getSponsorSegmentsHandler({ video: VIDEO });

    expect(structuredOf(result).segments).toEqual([
      {
        category: 'intro',
        startSeconds: 0,
        endSeconds: 10,
        durationSeconds: 10,
        votes: 4,
        timestamp: '0:00',
        url: `https://www.youtube.com/watch?v=${VIDEO}&t=0s`,
      },
      {
        category: 'sponsor',
        startSeconds: 61,
        endSeconds: 91.5,
        durationSeconds: 30.5,
        votes: 9,
        timestamp: '1:01',
        url: `https://www.youtube.com/watch?v=${VIDEO}&t=61s`,
      },
    ]);
  });

  it('adds up how much of the video the segments cover', async () => {
    const result = await getSponsorSegmentsHandler({ video: VIDEO });

    expect(structuredOf(result)).toMatchObject({ count: 2, coveredSeconds: 40.5 });
    expect(textOf(result)).toContain('2 segments');
    expect(textOf(result)).toContain('0:00 – 0:10');
  });

  it('counts overlapping segments once in the total', async () => {
    vi.mocked(fetchSponsorSegments).mockResolvedValue([
      { category: 'selfpromo', startSeconds: 10, endSeconds: 40, durationSeconds: 30, votes: 2 },
      { category: 'sponsor', startSeconds: 15, endSeconds: 25, durationSeconds: 10, votes: 5 },
    ]);

    const result = await getSponsorSegmentsHandler({ video: VIDEO });

    expect(structuredOf(result)).toMatchObject({ count: 2, coveredSeconds: 30 });
  });

  it('says plainly that nobody has marked anything, which is not the same as nothing being there', async () => {
    vi.mocked(fetchSponsorSegments).mockResolvedValue([]);

    const result = await getSponsorSegmentsHandler({ video: VIDEO });

    expect(structuredOf(result)).toMatchObject({ count: 0, coveredSeconds: 0, segments: [] });
    expect(textOf(result)).toContain('No one has marked');
  });

  it('says where the data comes from, so it is not taken for YouTube’s own', async () => {
    const result = await getSponsorSegmentsHandler({ video: VIDEO });

    expect(textOf(result)).toContain('SponsorBlock');
    expect(structuredOf(result)).toMatchObject({ source: 'sponsorblock' });
  });
});
