import { describe, it, expect } from 'vitest';
import { selectChannelImages } from '../../src/utils/channel-images.js';

/** The channel-level array verified against yt-dlp 2026.07.04 on 2026-09-05. */
const HOST = 'https://yt3.googleusercontent.com';
const LISTED = [
  { url: `${HOST}/banner=w1060`, height: 175, width: 1060, preference: -10, id: '0' },
  { url: `${HOST}/banner=w1138`, height: 188, width: 1138, preference: -10, id: '1' },
  { url: `${HOST}/banner=w2560`, height: 424, width: 2560, preference: -10, id: '5' },
  { url: `${HOST}/banner=s0`, id: 'banner_uncropped', preference: -5 },
  { url: `${HOST}/avatar=s900`, height: 900, width: 900, id: '7' },
  { url: `${HOST}/avatar=s0`, id: 'avatar_uncropped', preference: 1 },
];

describe('selectChannelImages', () => {
  it('prefers the uncropped avatar and banner', () => {
    expect(selectChannelImages(LISTED)).toEqual({
      avatarUrl: `${HOST}/avatar=s0`,
      bannerUrl: `${HOST}/banner=s0`,
    });
  });

  it('falls back to the largest square and the widest banner crop when the ids are absent', () => {
    const withoutIds = LISTED.filter((image) => !image.id.includes('uncropped'));
    expect(selectChannelImages(withoutIds)).toEqual({
      avatarUrl: `${HOST}/avatar=s900`,
      bannerUrl: `${HOST}/banner=w2560`,
    });
  });

  it('does not mistake a wide banner crop for an avatar or a square for a banner', () => {
    expect(selectChannelImages([LISTED[0]])).toEqual({ bannerUrl: `${HOST}/banner=w1060` });
    expect(selectChannelImages([LISTED[4]])).toEqual({ avatarUrl: `${HOST}/avatar=s900` });
  });

  it('drops images on hosts outside the allowlist', () => {
    expect(
      selectChannelImages([
        { url: 'https://evil.example/avatar', id: 'avatar_uncropped' },
        { url: 'not a url', id: 'banner_uncropped' },
      ])
    ).toEqual({});
  });

  it('ignores images whose size is unknown when falling back on geometry', () => {
    expect(
      selectChannelImages([
        { url: `${HOST}/no-size`, id: '9' },
        { url: `${HOST}/half`, id: '10', width: 100, height: null },
        { url: `${HOST}/square`, id: '11', width: 88, height: 88 },
      ])
    ).toEqual({ avatarUrl: `${HOST}/square` });
  });

  it('returns nothing for a missing or malformed list', () => {
    expect(selectChannelImages(undefined)).toEqual({});
    expect(selectChannelImages('nope')).toEqual({});
    expect(selectChannelImages([{ width: 1 }])).toEqual({});
  });
});
