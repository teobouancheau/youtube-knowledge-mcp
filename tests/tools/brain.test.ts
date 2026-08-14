import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { structuredOf, textOf } from '../helpers.js';
import { YouTubeError } from '../../src/utils/errors.js';
import {
  formatTimestamp,
  segmentsToText,
  type TranscriptSegment,
} from '../../src/utils/transcript.js';
import type {
  Chapter,
  TranscriptResult,
  VideoDetails,
  VideoListItem,
} from '../../src/utils/youtube.js';

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
  getVideoDetails: vi.fn(),
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

function details(
  uploadDate = '2025-03-01',
  durationSeconds = 600,
  chapters: Chapter[] = []
): VideoDetails {
  return { uploadDate, durationSeconds, chapters };
}

function chapter(title: string, startTime: number, endTime: number): Chapter {
  return {
    title,
    startTime,
    endTime,
    startTimeFormatted: formatTimestamp(startTime),
    endTimeFormatted: formatTimestamp(endTime),
  };
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

const DEFAULTS = { maxVideos: 100, language: 'en', minDurationSeconds: 0 };

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ytk-brain-tool-'));
  process.env.TEST_HOME = home;
  vi.clearAllMocks();

  const youtube = await stubYouTube();
  youtube.getChannelInfo.mockResolvedValue(CHANNEL);
  youtube.getVideoDetails.mockResolvedValue(details());
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
      structuredOf(await ask({ channel: '@Fireship', query: 'caching', limit: 25, offset: 0 }))
        .passages
    ).toHaveLength(count);
  });

  it('reads the uploads tab, not every tab the channel has', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([video('a', 'One'), video('b', 'Two')]);
    youtube.getTranscript.mockImplementation((id: string) =>
      Promise.resolve(transcript(id, segments(`words for ${id}`)))
    );

    const { build } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });

    expect(youtube.listVideos).toHaveBeenCalledWith(`${CHANNEL.channelUrl}/videos`, 100);
  });

  it('never considers more videos than it was asked for', async () => {
    const youtube = await stubYouTube();
    // A bare channel URL expands per tab, so yt-dlp can return more than the
    // limit however politely it was asked.
    youtube.listVideos.mockResolvedValue(
      Array.from({ length: 8 }, (_unused, index) => video(`v${index}`, `Episode ${index}`))
    );
    youtube.getTranscript.mockImplementation((id: string) =>
      Promise.resolve(transcript(id, segments(`words for ${id}`)))
    );

    const { build } = await tools();
    const structured = structuredOf(
      await build({ channel: '@Fireship', ...DEFAULTS, maxVideos: 2 })
    );

    expect(structured).toMatchObject({ considered: 2, processed: 2 });
  });

  it('reports a listing failure instead of retrying somewhere else', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockRejectedValue(new YouTubeError('RATE_LIMITED', 'slow down'));

    const { build } = await tools();

    await expect(build({ channel: '@Fireship', ...DEFAULTS })).rejects.toThrow(
      expect.objectContaining({ code: 'RATE_LIMITED' })
    );
    expect(youtube.listVideos).toHaveBeenCalledTimes(1);
  });

  it('records the upload date the flat listing does not carry', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([video('a', 'One', 600, '')]);
    youtube.getTranscript.mockResolvedValue(transcript('a', segments('words')));
    youtube.getVideoDetails.mockResolvedValue(details('2025-04-09'));

    const { build, info } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });

    expect(textOf(await info({ channel: '@Fireship', includeVideos: false }))).toContain(
      'Uploads from 2025-04-09'
    );
  });

  it('resolves real dates before deciding what to read', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([
      video('old', 'Old', 600, ''),
      video('new', 'New', 600, ''),
    ]);
    youtube.getTranscript.mockImplementation((id: string) =>
      Promise.resolve(transcript(id, segments(`words for ${id}`)))
    );
    youtube.getVideoDetails.mockImplementation((id: string) =>
      Promise.resolve(details(id === 'old' ? '2019-01-01' : '2025-04-09'))
    );

    const { build } = await tools();
    const structured = structuredOf(
      await build({ channel: '@Fireship', ...DEFAULTS, since: '2024-01-01' })
    );

    expect(structured).toMatchObject({ considered: 1, processed: 1 });
    expect(structured.stats).toMatchObject({ firstUpload: '2025-04-09' });
  });

  it('reads the caption language it was asked for', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([video('a', 'Une vidéo')]);
    youtube.getTranscript.mockResolvedValue(transcript('a', segments('bonjour tout le monde')));

    const { build } = await tools();
    const structured = structuredOf(
      await build({ channel: '@Fireship', ...DEFAULTS, language: 'fr' })
    );

    expect(youtube.getTranscript).toHaveBeenCalledWith('a', { language: 'fr' });
    expect(structured.language).toBe('fr');
  });

  it('refuses a language that is not a language', async () => {
    const { build } = await tools();

    await expect(
      build({ channel: '@Fireship', ...DEFAULTS, language: '../../etc' })
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('re-reads a video whose passages have gone missing', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([video('a', 'One')]);
    youtube.getTranscript.mockResolvedValue(transcript('a', segments('the passage text')));

    const { build, ask } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });

    // A crash between writing the manifest and writing the passages, a
    // half-restored backup, a truncated file: the manifest says the video was
    // read and the corpus cannot account for it.
    await rm(join(home, '.youtube-knowledge', 'brains', CHANNEL_ID, 'chunks.json'));

    const repaired = structuredOf(await build({ channel: '@Fireship', ...DEFAULTS }));

    expect(repaired).toMatchObject({ processed: 1, skipped: 0 });
    expect(
      structuredOf(await ask({ channel: '@Fireship', query: 'passage', limit: 8, offset: 0 }))
        .passages
    ).toHaveLength(1);
  });

  it('reads at the concurrency the yt-dlp limiter is set to', async () => {
    const youtube = await stubYouTube();
    const { concurrencyState } = await import('../../src/utils/ytdlp.js');
    const { limit } = concurrencyState();

    youtube.listVideos.mockResolvedValue(
      Array.from({ length: limit * 3 }, (_unused, index) => video(`v${index}`, `Episode ${index}`))
    );

    let inFlight = 0;
    let peak = 0;
    youtube.getVideoDetails.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return details();
    });
    youtube.getTranscript.mockImplementation((id: string) =>
      Promise.resolve(transcript(id, segments(`words for ${id}`)))
    );

    const { build } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });

    expect(peak).toBe(limit);
  });

  it('leaves the phrase pass for a finished corpus', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue(
      Array.from({ length: 12 }, (_unused, index) => video(`v${index}`, `Episode ${index}`))
    );
    youtube.getTranscript.mockImplementation((id: string) =>
      Promise.resolve(transcript(id, segments(`and thats it for today from ${id}`)))
    );

    const { build, info } = await tools();
    const finished = structuredOf(await build({ channel: '@Fireship', ...DEFAULTS }));

    // The build checkpointed at ten videos and finished at twelve; only the
    // finished corpus is measured for phrases.
    expect((finished.stats as { recurringPhrases?: unknown[] }).recurringPhrases).toBeDefined();
    expect(textOf(await info({ channel: '@Fireship', includeVideos: false }))).toContain(
      'Phrases repeated across videos'
    );
  });

  it('says phrases are unmeasured after an interrupted build, rather than none', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue(
      Array.from({ length: 6 }, (_unused, index) => video(`v${index}`, `Episode ${index}`))
    );

    const controller = new AbortController();
    let read = 0;
    youtube.getTranscript.mockImplementation((id: string) => {
      if (++read === 3) controller.abort();
      return Promise.resolve(transcript(id, segments(`and thats it for today from ${id}`)));
    });

    const { build, info } = await tools();
    const { runWithRequestContext } = await import('../../src/utils/context.js');

    await expect(
      runWithRequestContext({ signal: controller.signal }, () =>
        build({ channel: '@Fireship', ...DEFAULTS })
      )
    ).rejects.toThrow();

    const partial = await info({ channel: '@Fireship', includeVideos: false });

    expect(
      (structuredOf(partial).stats as { recurringPhrases?: unknown[] }).recurringPhrases
    ).toBeUndefined();
    expect(textOf(partial)).toContain('have not been measured yet');
  });

  it('keeps what it read when the client cancels partway', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue(
      Array.from({ length: 6 }, (_unused, index) => video(`v${index}`, `Episode ${index}`))
    );

    // Fewer than one checkpoint's worth, so anything kept was kept by the
    // cancellation path rather than by a periodic save.
    const controller = new AbortController();
    let read = 0;
    youtube.getTranscript.mockImplementation((id: string) => {
      if (++read === 3) controller.abort();
      return Promise.resolve(transcript(id, segments(`words for ${id}`)));
    });

    const { build, info } = await tools();
    const { runWithRequestContext } = await import('../../src/utils/context.js');

    await expect(
      runWithRequestContext({ signal: controller.signal }, () =>
        build({ channel: '@Fireship', ...DEFAULTS })
      )
    ).rejects.toThrow();

    const stats = structuredOf(await info({ channel: '@Fireship', includeVideos: false })).stats;

    expect(stats).toMatchObject({ indexedCount: 3 });
  });

  it('re-applies a changed filter, so the brain always matches it', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([
      video('old', 'Old', 600, ''),
      video('new', 'New', 600, ''),
    ]);
    youtube.getTranscript.mockImplementation((id: string) =>
      Promise.resolve(
        transcript(
          id,
          segments(id === 'old' ? 'floppy disks and dial up modems' : 'modern rust tooling')
        )
      )
    );
    youtube.getVideoDetails.mockImplementation((id: string) =>
      Promise.resolve(details(id === 'old' ? '2019-01-01' : '2025-04-09'))
    );

    const { build, info } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });

    // Narrowing: the old video was read, and is now outside the range. It is
    // decided from the date already recorded, so nothing is fetched to decide
    // it, and its passages leave the corpus with it.
    youtube.getVideoDetails.mockClear();
    const narrowed = structuredOf(
      await build({ channel: '@Fireship', ...DEFAULTS, since: '2024-01-01' })
    );

    expect(narrowed).toMatchObject({ considered: 1, excluded: 1, processed: 0 });
    expect(youtube.getVideoDetails).not.toHaveBeenCalled();
    expect(
      structuredOf(await info({ channel: '@Fireship', includeVideos: false })).stats
    ).toMatchObject({ videoCount: 1, indexedCount: 1, chunkCount: 1, firstUpload: '2025-04-09' });

    // And a search cannot reach what the filters exclude.
    const { ask } = await tools();
    expect(
      structuredOf(
        await ask({ channel: '@Fireship', query: 'floppy disks modems', limit: 8, offset: 0 })
      ).passages
    ).toEqual([]);

    // Widening: it comes back.
    const widened = structuredOf(await build({ channel: '@Fireship', ...DEFAULTS }));

    expect(widened).toMatchObject({ considered: 2, excluded: 0 });
    expect(
      structuredOf(await info({ channel: '@Fireship', includeVideos: false })).stats
    ).toMatchObject({ videoCount: 2, indexedCount: 2, chunkCount: 2 });
    expect(
      structuredOf(
        await ask({ channel: '@Fireship', query: 'floppy disks modems', limit: 8, offset: 0 })
      ).passages
    ).toHaveLength(1);
  });

  it('rules out a short video from the listing alone', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue([
      video('short', 'A short', 30),
      video('full', 'Full', 600),
    ]);
    youtube.getTranscript.mockImplementation((id: string) =>
      Promise.resolve(transcript(id, segments(`words for ${id}`)))
    );

    const { build } = await tools();
    const structured = structuredOf(
      await build({ channel: '@Fireship', ...DEFAULTS, minDurationSeconds: 60 })
    );

    expect(structured).toMatchObject({ considered: 1, processed: 1, excluded: 1 });
    // The listing already said it was 30 seconds long, so nothing was fetched
    // to find that out again.
    expect(youtube.getVideoDetails).toHaveBeenCalledTimes(1);
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
    youtube.getVideoDetails.mockImplementation((id: string) =>
      Promise.resolve(
        details(id === 'old' ? '2019-01-01' : '2025-03-01', id === 'short' ? 30 : 600)
      )
    );

    const { build } = await tools();
    const structured = structuredOf(
      await build({
        channel: '@Fireship',
        ...DEFAULTS,
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
    youtube.getVideoDetails.mockResolvedValue(
      details('2025-03-01', 600, [chapter('Intro', 0, 120), chapter('Ownership', 120, 150)])
    );

    const { build } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });
  });

  it('returns the passage that answers the question, with a link to the moment', async () => {
    const { ask } = await tools();
    const structured = structuredOf(
      await ask({ channel: '@Fireship', query: 'borrow checker memory', limit: 8, offset: 0 })
    );

    const passages = structured.passages as { url: string; startFormatted: string }[];

    expect(passages[0]?.url).toContain('&t=120s');
    expect(passages[0]?.startFormatted).toBe('2:00');
    expect(
      textOf(await ask({ channel: '@Fireship', query: 'borrow checker', limit: 8, offset: 0 }))
    ).toContain('borrow checker');
  });

  it('resolves a brain by channel id, handle and name without touching the network', async () => {
    const youtube = await stubYouTube();
    const { ask } = await tools();
    // Building the brain resolved the channel once; asking it must not.
    youtube.getChannelInfo.mockClear();

    for (const name of [CHANNEL_ID, '@Fireship', 'Fireship', CHANNEL.channelUrl]) {
      const structured = structuredOf(
        await ask({ channel: name, query: 'rust', limit: 8, offset: 0 })
      );
      expect(structured.channelId).toBe(CHANNEL_ID);
    }

    expect(youtube.getChannelInfo).not.toHaveBeenCalled();
  });

  it('reports how many passages matched, not how many it returned', async () => {
    const youtube = await stubYouTube();
    youtube.listVideos.mockResolvedValue(
      Array.from({ length: 6 }, (_unused, index) => video(`v${index}`, `Episode ${index}`))
    );
    youtube.getTranscript.mockImplementation((id: string) =>
      Promise.resolve(transcript(id, segments(`kubernetes autoscaling in ${id}`)))
    );

    const { build, ask } = await tools();
    await build({ channel: '@Fireship', ...DEFAULTS });

    const page = structuredOf(
      await ask({ channel: '@Fireship', query: 'kubernetes autoscaling', limit: 2, offset: 0 })
    );

    expect(page).toMatchObject({ total: 6, count: 2, hasMore: true, nextOffset: 2 });
    expect(page.passages).toHaveLength(2);

    const second = structuredOf(
      await ask({ channel: '@Fireship', query: 'kubernetes autoscaling', limit: 2, offset: 2 })
    );

    expect(second).toMatchObject({ total: 6, offset: 2, hasMore: true });
    expect(
      (second.passages as { videoId: string }[]).map((passage) => passage.videoId)
    ).not.toEqual((page.passages as { videoId: string }[]).map((passage) => passage.videoId));
  });

  it('says so when nothing matches rather than inventing an answer', async () => {
    const { ask } = await tools();
    const result = await ask({
      channel: '@Fireship',
      query: 'sourdough hydration',
      limit: 8,
      offset: 0,
    });

    expect(structuredOf(result).passages).toEqual([]);
    expect(textOf(result)).toContain('Nothing in');
  });

  it('refuses a channel with no brain, naming the tool that builds one', async () => {
    const { ask } = await tools();

    await expect(
      ask({ channel: '@Unknown', query: 'anything', limit: 8, offset: 0 })
    ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
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
    await expect(ask({ channel: '@Fireship', query: 'rust', limit: 8, offset: 0 })).rejects.toThrow(
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
    // YouTube reports no publication date for these, which the report has to
    // say plainly rather than fill in.
    youtube.getVideoDetails.mockResolvedValue(details(''));

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
