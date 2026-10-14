import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';
import { coverageOf } from '../../src/utils/coverage.js';

vi.mock('../../src/utils/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/store.js')>()),
  getStore: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../src/utils/harvest-details.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/harvest-details.js')>()),
  harvestDetails: vi.fn(),
}));

import { harvestDetails } from '../../src/utils/harvest-details.js';
import { harvestDetailsHandler } from '../../src/tools/harvest-details.js';

const CHANNEL = 'UCaaaaaaaaaaaaaaaaaaaaaa';

type Details = Awaited<ReturnType<typeof harvestDetails>>;

function result(overrides: Partial<Details> = {}): Details {
  return {
    channelId: CHANNEL,
    name: 'Example',
    attempted: 50,
    stored: 48,
    failures: [{ videoId: 'v9', code: 'PRIVATE' as const }],
    remaining: 120,
    coverage: coverageOf({
      scope: 'video-details',
      targetId: CHANNEL,
      have: 48,
      source: 'test',
    }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(harvestDetails).mockResolvedValue(result());
});

describe('harvestDetailsHandler', () => {
  it('forwards the channel, the cap and whether to retry unreadable videos', async () => {
    await harvestDetailsHandler({ channel: '@example', maxVideos: 80, retryUnreadable: true });

    expect(harvestDetails).toHaveBeenCalledWith(expect.anything(), '@example', {
      maxVideos: 80,
      retryUnreadable: true,
    });
  });

  it('leads with the receipt, then says what this run did and what is left', async () => {
    const outcome = await harvestDetailsHandler({
      channel: '@example',
      maxVideos: 50,
      retryUnreadable: false,
    });

    const text = textOf(outcome);
    expect(text).toContain('48 of 50');
    expect(text).toContain('120 still unread');
    expect(text).toContain('Call harvest_details again');
  });

  it('lists the videos that failed and why', async () => {
    const outcome = await harvestDetailsHandler({
      channel: '@example',
      maxVideos: 50,
      retryUnreadable: false,
    });

    expect(textOf(outcome)).toContain('v9 (PRIVATE)');
    expect(structuredOf(outcome)).toMatchObject({
      channelId: CHANNEL,
      attempted: 50,
      stored: 48,
      remaining: 120,
      failures: [{ videoId: 'v9', code: 'PRIVATE' }],
    });
  });

  it('says why it stopped early, so a refusal is not mistaken for being done', async () => {
    vi.mocked(harvestDetails).mockResolvedValue(
      result({ stoppedBecause: 'BOT_CHECK', failures: [], remaining: 30 })
    );

    const outcome = await harvestDetailsHandler({
      channel: '@example',
      maxVideos: 50,
      retryUnreadable: false,
    });

    expect(textOf(outcome)).toContain('Stopped early: BOT_CHECK');
    expect(structuredOf(outcome)).toMatchObject({ stoppedBecause: 'BOT_CHECK' });
  });

  it('says nothing is left when it is done', async () => {
    vi.mocked(harvestDetails).mockResolvedValue(result({ remaining: 0, failures: [] }));

    const outcome = await harvestDetailsHandler({
      channel: '@example',
      maxVideos: 50,
      retryUnreadable: false,
    });

    expect(textOf(outcome)).not.toContain('Call harvest_details again');
  });
});
