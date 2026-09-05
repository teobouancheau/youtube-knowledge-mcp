import { describe, it, expect } from 'vitest';
import { findByChannel } from '../../src/utils/channel-lookup.js';

const fireship = {
  channel: {
    name: 'Fireship',
    channelId: 'UCsBjURrPoezykLs9EqgamOA',
    handle: '@Fireship',
    subscriberCount: 1,
    channelUrl: 'https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA',
    description: '',
  },
};
const other = {
  channel: {
    ...fireship.channel,
    name: 'Other',
    channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
    handle: '',
    channelUrl: 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw',
  },
};

describe('findByChannel', () => {
  it.each([
    ['the id', 'UCsBjURrPoezykLs9EqgamOA'],
    ['the handle', '@Fireship'],
    ['the handle without @', 'fireship'],
    ['the name, any case', 'FIRESHIP'],
    [
      'the channel URL with a trailing slash',
      'https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA/',
    ],
    ['a URL containing the handle', 'https://www.youtube.com/@Fireship/videos'],
    ['text containing the id', 'see UCsBjURrPoezykLs9EqgamOA please'],
  ])('finds a record by %s', (_label, input) => {
    expect(findByChannel([fireship, other], input)).toEqual([fireship]);
  });

  it('returns nothing for a channel nobody stored', () => {
    expect(findByChannel([fireship, other], '@nobody')).toEqual([]);
  });

  it('returns every match, so the caller can report ambiguity', () => {
    const twin = { channel: { ...other.channel, name: 'Fireship' } };
    expect(findByChannel([fireship, twin], 'fireship')).toHaveLength(2);
  });

  it('ignores an empty handle rather than matching everything on it', () => {
    expect(findByChannel([other], '')).toEqual([]);
  });
});
