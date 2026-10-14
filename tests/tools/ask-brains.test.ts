import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/brain-storage.js', () => ({ listManifests: vi.fn() }));
vi.mock('../../src/utils/brain-lookup.js', () => ({ resolveBrain: vi.fn() }));
vi.mock('../../src/utils/brain-index.js', () => ({ searchBrain: vi.fn() }));

import { listManifests } from '../../src/utils/brain-storage.js';
import { resolveBrain } from '../../src/utils/brain-lookup.js';
import { searchBrain } from '../../src/utils/brain-index.js';
import { askBrainsHandler } from '../../src/tools/ask-brains.js';

const brain = (channelId: string, name: string): never =>
  ({ channel: { channelId, name, handle: `@${name}` } }) as never;

const passage = (videoId: string, score: number, text = 'something said'): never =>
  ({
    videoId,
    title: `Video ${videoId}`,
    startSeconds: 10,
    startFormatted: '0:10',
    endSeconds: 20,
    score,
    text,
    url: `https://www.youtube.com/watch?v=${videoId}&t=10s`,
  }) as never;

const FIRST = brain('UCaaa', 'First');
const SECOND = brain('UCbbb', 'Second');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listManifests).mockResolvedValue([FIRST, SECOND]);
  vi.mocked(searchBrain).mockImplementation((channelId) =>
    Promise.resolve(
      channelId === 'UCaaa'
        ? { passages: [passage('a1', 9), passage('a2', 8)], total: 12 }
        : { passages: [passage('b1', 2)], total: 1 }
    )
  );
});

describe('askBrainsHandler', () => {
  const args = { query: 'compound interest', limit: 10 };

  it('searches every brain that exists when none is named', async () => {
    await askBrainsHandler(args);

    expect(searchBrain).toHaveBeenCalledTimes(2);
    expect(searchBrain).toHaveBeenCalledWith('UCaaa', 'compound interest', 10);
    expect(searchBrain).toHaveBeenCalledWith('UCbbb', 'compound interest', 10);
  });

  it('searches only the brains it was told to', async () => {
    vi.mocked(resolveBrain).mockResolvedValue(SECOND);

    await askBrainsHandler({ ...args, channels: ['@Second'] });

    expect(resolveBrain).toHaveBeenCalledWith('@Second');
    expect(listManifests).not.toHaveBeenCalled();
    expect(searchBrain).toHaveBeenCalledTimes(1);
  });

  it('does not search the same brain twice when it was named twice', async () => {
    vi.mocked(resolveBrain).mockResolvedValue(SECOND);

    await askBrainsHandler({ ...args, channels: ['@Second', 'UCbbb'] });

    expect(searchBrain).toHaveBeenCalledTimes(1);
  });

  it('interleaves the brains by rank and names the channel on every passage', async () => {
    const result = await askBrainsHandler(args);

    const passages = structuredOf(result).passages as { videoId: string; channelName: string }[];
    expect(passages.map((entry) => entry.videoId)).toEqual(['a1', 'b1', 'a2']);
    expect(passages.map((entry) => entry.channelName)).toEqual(['First', 'Second', 'First']);
    expect(passages[0]).toMatchObject({ channelId: 'UCaaa', url: expect.any(String) });
  });

  it('keeps at most the limit', async () => {
    const result = await askBrainsHandler({ ...args, limit: 2 });

    expect(structuredOf(result).passages).toHaveLength(2);
  });

  it('reports how many passages each brain matched, so a thin channel is visible', async () => {
    const result = await askBrainsHandler(args);

    expect(structuredOf(result)).toMatchObject({
      brainsSearched: 2,
      searched: [
        { channelId: 'UCaaa', name: 'First', matches: 12 },
        { channelId: 'UCbbb', name: 'Second', matches: 1 },
      ],
    });
  });

  it('says plainly when nothing matches, and where to look next', async () => {
    vi.mocked(searchBrain).mockResolvedValue({ passages: [], total: 0 });

    const result = await askBrainsHandler(args);

    expect(textOf(result)).toContain('Nothing in 2 brains matches "compound interest"');
    expect(structuredOf(result).passages).toEqual([]);
  });

  it('tells the caller to build a brain when none exists', async () => {
    vi.mocked(listManifests).mockResolvedValue([]);

    await expect(askBrainsHandler(args)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      nextStep: expect.stringContaining('build_brain'),
    });
    expect(searchBrain).not.toHaveBeenCalled();
  });
});
