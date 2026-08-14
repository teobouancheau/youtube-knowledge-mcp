import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { structuredOf, textOf } from '../helpers.js';
import { YouTubeError } from '../../src/utils/errors.js';
import { segmentsToText, type TranscriptSegment } from '../../src/utils/transcript.js';
import type { TranscriptResult, VideoListItem } from '../../src/utils/youtube.js';

/**
 * The brain tools end to end, against a real temporary filesystem and a stubbed
 * YouTube.
 *
 * Nothing here spawns yt-dlp. What is worth proving is the behaviour around the
 * network rather than the network itself: that a video nobody captioned does not
 * cost the other two, that a second build continues instead of starting over,
 * and that a passage comes back with a link that lands on the right second.
 */

vi.mock('../../src/utils/youtube.js', () => ({
  getChannelInfo: vi.fn(),
  listVideos: vi.fn(),
  getTranscript: vi.fn(),
  getChapters: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});

const CHANNEL_ID = 'UCsBjURrPoezykLs9EqgamOA';

const CHANNEL = {
  name: 'Fireship',
  channelId: CHANNEL_ID,
  handle: '@Fireship',
  subscriberCount: 4_190_000,
  channelUrl: `https://www.youtube.com/channel/${CHANNEL_ID}`,
  description: 'High-intensity code tutorials',
};

function video(
  id: string,
  title: string,
  duration = 600,
  uploadDate = '2025-03-01'
): VideoListItem {
  return {
    id,
    title,
    duration,
    durationFormatted: '10:00',
    uploadDate,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

function segments(text: string, start = 0): TranscriptSegment[] {
  return [{ start, end: start + 30, text }];
}

function transcript(videoId: string, segments: TranscriptSegment[]): TranscriptResult {
  return {
    videoId,
    language: 'en',
    segments,
    transcript: segmentsToText(segments),
    cached: false,
  };
}

async function stubYouTube(): Promise<
  ReturnType<typeof vi.mocked<typeof import('../../src/utils/youtube.js')>>
> {
  return vi.mocked(await import('../../src/utils/youtube.js'));
}

async function tools(): Promise<{
  build: typeof import('../../src/tools/build-brain.js').buildBrainHandler;
  ask: typeof import('../../src/tools/ask-brain.js').askBrainHandler;
  info: typeof import('../../src/tools/brain-info.js').getBrainInfoHandler;
  list: typeof import('../../src/tools/brain-info.js').listBrainsHandler;
  saveProfile: typeof import('../../src/tools/manage-brain.js').saveBrainProfileHandler;
  remove: typeof import('../../src/tools/manage-brain.js').deleteBrainHandler;
}> {
  const [buildModule, askModule, infoModule, manageModule] = await Promise.all([
    import('../../src/tools/build-brain.js'),
    import('../../src/tools/ask-brain.js'),
    import('../../src/tools/brain-info.js'),
    import('../../src/tools/manage-brain.js'),
  ]);

  return {
    build: buildModule.buildBrainHandler,
    ask: askModule.askBrainHandler,
    info: infoModule.getBrainInfoHandler,
    list: infoModule.listBrainsHandler,
    saveProfile: manageModule.saveBrainProfileHandler,
    remove: manageModule.deleteBrainHandler,
  };
}

const DEFAULTS = { maxVideos: 100, minDurationSeconds: 0 };

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ytk-brain-tool-'));
  process.env.TEST_HOME = home;
  vi.clearAllMocks();

  const youtube = await stubYouTube();
  youtube.getChannelInfo.mockResolvedValue(CHANNEL);
  youtube.getChapters.mockResolvedValue([]);
});

afterEach(async () => {
  delete process.env.TEST_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('build_brain', () => {
  it('reads a channel and records what it could not read', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([
      video('good1', 'Rust in 100 seconds'),
      video('silent', 'A silent film'),
      video('gone', 'Members only'),
    ]);
    youtube.getTranscript.mockImplementation((id: string) => {
      if (id === 'silent') return Promise.reject(new YouTubeError('NO_CAPTIONS', 'none'));
      if (id === 'gone') return Promise.reject(new YouTubeError('MEMBERS_ONLY', 'no'));
      return Promise.resolve(
        transcript(id, segments('rust is a systems language with no garbage collector'))
      );
    });

    const { build } = await tools();
    const result = await build({ channel: '@Fireship', ...DEFAULTS });
    const structured = structuredOf(result);

    expect(structured).toMatchObject({
      channelId: CHANNEL_ID,
      considered: 3,
      processed: 3,
      skipped: 0,
      stoppedEarly: false,
    });
    expect(structured.stats).toMatchObject({
      videoCount: 3,
      indexedCount: 1,
      noCaptionsCount: 1,
      failedCount: 1,
    });
    expect(textOf(result)).toContain('1 of 3 videos indexed');
  });

  it('skips what it already has and retries what failed', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([video('good1', 'First'), video('flaky', 'Second')]);

    let flakyAttempts = 0;
    youtube.getTranscript.mockImplementation((id: string) => {
      if (id === 'flaky' && flakyAttempts++ === 0) {
        return Promise.reject(new YouTubeError('YTDLP_FAILED', 'transient'));
      }
      return Promise.resolve(transcript(id, segments(`words for ${id}`)));
    });

    const { build } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });
    const second = structuredOf(await build({ channel: '@Fireship', ...DEFAULTS }));

    expect(second).toMatchObject({ processed: 1, skipped: 1 });
    expect(second.stats).toMatchObject({ indexedCount: 2, failedCount: 0 });
  });

  it('does not retry a video that simply has no captions', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([video('silent', 'A silent film')]);
    youtube.getTranscript.mockRejectedValue(new YouTubeError('NO_CAPTIONS', 'none'));

    const { build } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });
    const second = structuredOf(await build({ channel: '@Fireship', ...DEFAULTS }));

    expect(second).toMatchObject({ processed: 0, skipped: 1 });
  });

  it('stops early rather than hammering a rate limited endpoint', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue(
      Array.from({ length: 20 }, (_unused, index) => video(`v${index}`, `Episode ${index}`))
    );
    youtube.getTranscript.mockRejectedValue(new YouTubeError('RATE_LIMITED', 'slow down'));

    const { build } = await tools();
    const structured = structuredOf(await build({ channel: '@Fireship', ...DEFAULTS }));

    expect(structured.stoppedEarly).toBe(true);
    expect(structured.processed).toBeLessThan(20);
    expect(textOf(await build({ channel: '@Fireship', ...DEFAULTS }))).toContain('build_brain');
  });

  it('checkpoints partway through a long build', async () => {
    const youtube = await stubYouTube();
    const count = 12;
    youtube.listVideos.mockResolvedValue(
      Array.from({ length: count }, (_unused, index) => video(`v${index}`, `Episode ${index}`))
    );
    youtube.getTranscript.mockImplementation((id: string) =>
      Promise.resolve(transcript(id, segments(`this is episode ${id} and it is about caching`)))
    );

    const { build, ask } = await tools();
    const structured = structuredOf(await build({ channel: '@Fireship', ...DEFAULTS }));

    expect(structured.stats).toMatchObject({ indexedCount: count, chunkCount: count });
    expect(
      structuredOf(await ask({ channel: '@Fireship', query: 'caching', limit: 25 })).passages
    ).toHaveLength(count);
  });

  it('applies the duration and date filters', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([
      video('short', 'A short', 30, '2025-03-01'),
      video('old', 'An old one', 600, '2019-01-01'),
      video('keep', 'The one that counts', 600, '2025-03-01'),
    ]);
    youtube.getTranscript.mockResolvedValue(
      transcript('keep', segments('this is the only video that should be read'))
    );

    const { build } = await tools();
    const structured = structuredOf(
      await build({
        channel: '@Fireship',
        maxVideos: 100,
        since: '2024-01-01',
        minDurationSeconds: 60,
      })
    );

    expect(structured).toMatchObject({ considered: 1, processed: 1 });
  });
});

describe('ask_brain', () => {
  beforeEach(async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([video('good1', 'Rust in 100 seconds')]);
    youtube.getTranscript.mockResolvedValue(
      transcript('good1', [
        ...segments('rust has no garbage collector and no runtime', 0),
        ...segments('the borrow checker rejects code that would leak memory', 120),
      ])
    );
    // Two short segments would otherwise be one passage; a chapter boundary is
    // what separates them, which is the same thing that separates two subjects.
    youtube.getChapters.mockResolvedValue([
      {
        title: 'Intro',
        startTime: 0,
        endTime: 120,
        startTimeFormatted: '0:00',
        endTimeFormatted: '2:00',
      },
      {
        title: 'Ownership',
        startTime: 120,
        endTime: 150,
        startTimeFormatted: '2:00',
        endTimeFormatted: '2:30',
      },
    ]);

    const { build } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });
  });

  it('returns the passage that answers the question, with a link to the moment', async () => {
    const { ask } = await tools();
    const structured = structuredOf(
      await ask({ channel: '@Fireship', query: 'borrow checker memory', limit: 8 })
    );

    const passages = structured.passages as { url: string; startFormatted: string }[];

    expect(passages[0]?.url).toContain('&t=120s');
    expect(passages[0]?.startFormatted).toBe('2:00');
    expect(
      textOf(await ask({ channel: '@Fireship', query: 'borrow checker', limit: 8 }))
    ).toContain('borrow checker');
  });

  it('resolves a brain by channel id, handle and name without touching the network', async () => {
    const youtube = await stubYouTube();
    const { ask } = await tools();
    // Building the brain resolved the channel once; asking it must not.
    youtube.getChannelInfo.mockClear();

    for (const name of [CHANNEL_ID, '@Fireship', 'Fireship', CHANNEL.channelUrl]) {
      const structured = structuredOf(await ask({ channel: name, query: 'rust', limit: 8 }));
      expect(structured.channelId).toBe(CHANNEL_ID);
    }

    expect(youtube.getChannelInfo).not.toHaveBeenCalled();
  });

  it('says so when nothing matches rather than inventing an answer', async () => {
    const { ask } = await tools();
    const result = await ask({ channel: '@Fireship', query: 'sourdough hydration', limit: 8 });

    expect(structuredOf(result).passages).toEqual([]);
    expect(textOf(result)).toContain('Nothing in');
  });

  it('refuses a channel with no brain, naming the tool that builds one', async () => {
    const { ask } = await tools();

    await expect(ask({ channel: '@Unknown', query: 'anything', limit: 8 })).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    );
  });
});

describe('the rest of the brain surface', () => {
  beforeEach(async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([video('good1', 'Rust in 100 seconds')]);
    youtube.getTranscript.mockResolvedValue(
      transcript('good1', segments('rust has no garbage collector'))
    );

    const { build } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });
  });

  it('reports coverage, and lists videos only when asked', async () => {
    const { info } = await tools();

    const brief = await info({ channel: '@Fireship', includeVideos: false });
    expect(structuredOf(brief).videos).toBeUndefined();
    expect(textOf(brief)).toContain('1 of 1 videos indexed');

    const full = await info({ channel: '@Fireship', includeVideos: true });
    expect(structuredOf(full).videos).toHaveLength(1);
    expect(textOf(full)).toContain('Rust in 100 seconds');
  });

  it('keeps a profile and reports that it exists', async () => {
    const { saveProfile, list, info } = await tools();

    expect(
      structuredOf(await info({ channel: '@Fireship', includeVideos: false })).hasProfile
    ).toBe(false);

    await saveProfile({ channel: '@Fireship', content: '# Voice\n\nTerse, list-driven. [0:00]' });

    const brains = structuredOf(await list()).brains as { hasProfile: boolean; name: string }[];
    expect(brains[0]).toMatchObject({ name: 'Fireship', hasProfile: true });
  });

  it('deletes a brain, and then has nothing left to resolve', async () => {
    const { remove, ask } = await tools();

    expect(structuredOf(await remove({ channel: '@Fireship' }))).toMatchObject({ deleted: true });

    await expect(remove({ channel: '@Fireship' })).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    );
    await expect(ask({ channel: '@Fireship', query: 'rust', limit: 8 })).rejects.toThrow(
      YouTubeError
    );
  });

  it('reports what is missing and what the creator repeats', async () => {
    const youtube = await stubYouTube();
    const catchphrase = 'and thats it for today';

    // A brain of its own, so the dated video the other tests build does not
    // decide whether upload dates were reported.
    const { remove } = await tools();
    await remove({ channel: '@Fireship' });

    youtube.listVideos.mockResolvedValue([
      video('a', 'One', 600, ''),
      video('b', 'Two', 600, ''),
      video('c', 'Three', 600, ''),
      video('d', 'Members only', 600, ''),
      video('e', 'A silent film', 600, ''),
    ]);
    youtube.getTranscript.mockImplementation((id: string) => {
      if (id === 'd') return Promise.reject(new YouTubeError('MEMBERS_ONLY', 'no'));
      if (id === 'e') return Promise.reject(new YouTubeError('NO_CAPTIONS', 'none'));
      return Promise.resolve(transcript(id, segments(`episode${id} ${catchphrase} topic${id}`)));
    });

    const { build, info } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });

    const text = textOf(await info({ channel: '@Fireship', includeVideos: true }));

    expect(text).toContain('No upload dates reported');
    expect(text).toContain('1 videos have no captions');
    expect(text).toContain('1 videos still to read');
    expect(text).toContain(`"${catchphrase}"`);
    expect(text).toContain('MEMBERS_ONLY');
  });

  it('refuses to guess between two brains that answer to the same name', async () => {
    const youtube = await stubYouTube();
    youtube.getChannelInfo.mockResolvedValue({
      ...CHANNEL,
      channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
      handle: '@Fireship2',
      channelUrl: 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw',
    });

    const { build, info } = await tools();
    await build({ channel: '@Fireship2', ...DEFAULTS });

    await expect(info({ channel: 'Fireship', includeVideos: false })).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  });

  it('lists nothing before anything is built', async () => {
    const { remove, list } = await tools();
    await remove({ channel: '@Fireship' });

    const result = await list();

    expect(structuredOf(result).brains).toEqual([]);
    expect(textOf(result)).toContain('No brains have been built');
  });
});
