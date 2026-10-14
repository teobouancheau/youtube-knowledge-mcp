import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';
import type { VideoStats } from '../../src/utils/video-stats.js';

vi.mock('../../src/utils/video-stats-cache.js', () => ({ readVideoStats: vi.fn() }));

import { readVideoStats } from '../../src/utils/video-stats-cache.js';
import { getVideoDetailsHandler } from '../../src/tools/get-video-details.js';
import { listCaptionsHandler } from '../../src/tools/list-captions.js';

const STATS: VideoStats = {
  id: 'dQw4w9WgXcQ',
  title: 'A Talk About Systems',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  channel: 'A Channel',
  channelId: 'UCch',
  channelUrl: 'https://www.youtube.com/channel/UCch',
  channelFollowerCount: 1200,
  uploadDate: '20260101',
  durationSeconds: 100,
  durationFormatted: '1:40',
  viewCount: 500,
  likeCount: 40,
  commentCount: 7,
  categories: ['Education'],
  tags: ['systems'],
  ageLimit: 0,
  availability: 'public',
  wasLive: false,
  license: 'Standard YouTube License',
  language: 'en',
  chapters: [{ title: 'Intro', startTime: 0, endTime: 50 }],
  captions: { manual: ['fr', 'en'], automatic: ['en-orig', 'en', 'de'] },
  hasHeatmap: true,
  heatmap: [
    { startSeconds: 0, endSeconds: 10, value: 0.2 },
    { startSeconds: 10, endSeconds: 20, value: 0.9 },
    { startSeconds: 20, endSeconds: 30, value: 0.3 },
    { startSeconds: 60, endSeconds: 70, value: 0.7 },
  ],
  descriptionChars: 5,
  description: 'hello',
  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readVideoStats).mockResolvedValue({ stats: STATS, cached: false });
});

describe('getVideoDetailsHandler', () => {
  const args = { video: 'dQw4w9WgXcQ', heatmap: false, refresh: false };

  it('reports the whole record, not just the headline numbers', async () => {
    const result = await getVideoDetailsHandler(args);

    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      title: 'A Talk About Systems',
      channelId: 'UCch',
      channelUrl: 'https://www.youtube.com/channel/UCch',
      categories: ['Education'],
      tags: ['systems'],
      license: 'Standard YouTube License',
      language: 'en',
      availability: 'public',
      chapterCount: 1,
      description: 'hello',
      cached: false,
    });
  });

  it('names the moments people replay most, each with a link that opens the video there', async () => {
    const result = await getVideoDetailsHandler(args);

    expect(structuredOf(result).mostReplayed).toEqual([
      {
        timestampSeconds: 10,
        timestamp: '0:10',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
        endSeconds: 20,
        value: 0.9,
      },
      {
        timestampSeconds: 60,
        timestamp: '1:00',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=60s',
        endSeconds: 70,
        value: 0.7,
      },
    ]);
    expect(textOf(result)).toContain('Most replayed: 0:10, 1:00');
  });

  it('leaves out the full heatmap unless it was asked for', async () => {
    expect(structuredOf(await getVideoDetailsHandler(args))).not.toHaveProperty('heatmap');
    expect(structuredOf(await getVideoDetailsHandler({ ...args, heatmap: true }))).toMatchObject({
      heatmap: STATS.heatmap,
    });
  });

  it('forwards a refresh to the stats read', async () => {
    await getVideoDetailsHandler({ ...args, refresh: true });

    expect(readVideoStats).toHaveBeenCalledWith('dQw4w9WgXcQ', { refresh: true });
  });

  it('says so when the numbers came from disk', async () => {
    vi.mocked(readVideoStats).mockResolvedValue({ stats: STATS, cached: true });

    const result = await getVideoDetailsHandler(args);

    expect(structuredOf(result)).toMatchObject({ cached: true });
    expect(textOf(result)).toContain('saved copy');
  });

  it('reports a video with no heatmap as having no replay data, not as an error', async () => {
    const { heatmap: _heatmap, ...withoutHeatmap } = STATS;
    vi.mocked(readVideoStats).mockResolvedValue({
      stats: { ...withoutHeatmap, hasHeatmap: false },
      cached: false,
    });

    const result = await getVideoDetailsHandler(args);

    expect(structuredOf(result).mostReplayed).toEqual([]);
    expect(textOf(result)).not.toContain('Most replayed');
  });

  it('carries music credits and the frame size when YouTube gave them', async () => {
    vi.mocked(readVideoStats).mockResolvedValue({
      stats: {
        ...STATS,
        music: { track: 'A Song', artist: 'An Artist' },
        video: { width: 1920, height: 1080, fps: 30 },
      },
      cached: false,
    });

    expect(structuredOf(await getVideoDetailsHandler(args))).toMatchObject({
      music: { track: 'A Song', artist: 'An Artist' },
      video: { width: 1920, height: 1080, fps: 30 },
    });
  });
});

describe('listCaptionsHandler', () => {
  it('separates human captions from automatic ones, sorted', async () => {
    const result = await listCaptionsHandler({ video: 'dQw4w9WgXcQ' });

    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      hasCaptions: true,
      manual: ['en', 'fr'],
      automatic: ['de', 'en'],
    });
  });

  it('names the language the video is spoken in, from the original auto-caption', async () => {
    const result = await listCaptionsHandler({ video: 'dQw4w9WgXcQ' });

    expect(structuredOf(result)).toMatchObject({ spokenLanguage: 'en' });
    expect(textOf(result)).toContain('Spoken language: en');
  });

  it('says plainly that a video has no captions, and what to use instead', async () => {
    vi.mocked(readVideoStats).mockResolvedValue({
      stats: { ...STATS, captions: { manual: [], automatic: [] } },
      cached: false,
    });

    const result = await listCaptionsHandler({ video: 'dQw4w9WgXcQ' });

    expect(structuredOf(result)).toMatchObject({ hasCaptions: false, manual: [], automatic: [] });
    expect(structuredOf(result)).not.toHaveProperty('spokenLanguage');
    expect(textOf(result)).toContain('no captions');
  });

  it('caps how many automatic languages the text lists, but not the structured list', async () => {
    const automatic = Array.from(
      { length: 80 },
      (_, index) => `l${String(index).padStart(2, '0')}`
    );
    vi.mocked(readVideoStats).mockResolvedValue({
      stats: { ...STATS, captions: { manual: [], automatic } },
      cached: false,
    });

    const result = await listCaptionsHandler({ video: 'dQw4w9WgXcQ' });

    expect(structuredOf(result).automatic).toHaveLength(80);
    expect(textOf(result)).toContain('and 55 more');
  });
});
