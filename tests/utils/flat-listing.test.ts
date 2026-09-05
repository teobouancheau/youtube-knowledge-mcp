import { describe, it, expect } from 'vitest';
import {
  FLAT_PRINT_TEMPLATE,
  flatEntrySchema,
  largestThumbnail,
  toVideoListItem,
} from '../../src/utils/flat-listing.js';

/** The two shapes verified against yt-dlp 2026.07.04 on 2026-09-05. */
const REGULAR = {
  id: 'rPq7ITrWFvY',
  title: 'Making Google Translate even easier',
  duration: 86,
  view_count: 54000,
  live_status: null,
  thumbnails: [
    { url: 'https://i.ytimg.com/vi/rPq7ITrWFvY/hq720_custom_3.jpg?sqp=a', width: 360, height: 202 },
    { url: 'https://i.ytimg.com/vi/rPq7ITrWFvY/hq720_custom_3.jpg?sqp=b', width: 720, height: 404 },
  ],
};

const SHORT = {
  id: '7k1sXY-ZCkI',
  title: 'On your marks. Get set. Search',
  duration: null,
  thumbnails: [
    { url: 'https://i.ytimg.com/vi/7k1sXY-ZCkI/sardefault.jpg?a', width: 405, height: 720 },
    { url: 'https://i.ytimg.com/vi/7k1sXY-ZCkI/sardefault.jpg?b', width: 405, height: 608 },
  ],
};

describe('FLAT_PRINT_TEMPLATE', () => {
  it('asks for one JSON object with the fields the parser reads', () => {
    expect(FLAT_PRINT_TEMPLATE).toMatch(/^%\(\.\{.*\}\)j$/);
    for (const field of Object.keys(flatEntrySchema.shape)) {
      expect(FLAT_PRINT_TEMPLATE).toContain(field);
    }
  });
});

describe('largestThumbnail', () => {
  it('picks the largest by area', () => {
    expect(largestThumbnail(REGULAR.thumbnails)?.width).toBe(720);
  });

  it('breaks an area tie by width', () => {
    const wide = { url: 'w', width: 800, height: 100 };
    const tall = { url: 't', width: 100, height: 800 };
    expect(largestThumbnail([tall, wide])?.url).toBe('w');
  });

  it('treats an image without a size as smallest', () => {
    expect(largestThumbnail([{ url: 'unsized' }, { url: 'sized', width: 1, height: 1 }])?.url).toBe(
      'sized'
    );
  });

  it('returns nothing for an empty list', () => {
    expect(largestThumbnail([])).toBeUndefined();
  });
});

describe('toVideoListItem', () => {
  it('maps a regular video, keeping the largest listed thumbnail', () => {
    expect(toVideoListItem(flatEntrySchema.parse(REGULAR))).toEqual({
      id: 'rPq7ITrWFvY',
      title: 'Making Google Translate even easier',
      duration: 86,
      durationFormatted: '1:26',
      uploadDate: '',
      url: 'https://www.youtube.com/watch?v=rPq7ITrWFvY',
      thumbnailUrl: 'https://i.ytimg.com/vi/rPq7ITrWFvY/hq720_custom_3.jpg?sqp=b',
      thumbnails: REGULAR.thumbnails,
      viewCount: 54000,
    });
  });

  it('maps a short, whose listed thumbnails are portrait', () => {
    const item = toVideoListItem(flatEntrySchema.parse(SHORT));
    expect(item.thumbnailUrl).toBe('https://i.ytimg.com/vi/7k1sXY-ZCkI/sardefault.jpg?a');
    expect(item.duration).toBe(0);
    expect(item).not.toHaveProperty('viewCount');
  });

  it('leaves the optional fields out when the listing has none', () => {
    const item = toVideoListItem(flatEntrySchema.parse({ id: 'abcdefghijk' }));
    expect(item).toEqual({
      id: 'abcdefghijk',
      title: 'Unknown title',
      duration: 0,
      durationFormatted: '0:00',
      uploadDate: '',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    });
  });

  it('carries a live status and an upload date when present', () => {
    const item = toVideoListItem(
      flatEntrySchema.parse({ id: 'wYSncx9zLIU', live_status: 'was_live', upload_date: '20240102' })
    );
    expect(item).toMatchObject({ liveStatus: 'was_live', uploadDate: '2024-01-02' });
  });
});
