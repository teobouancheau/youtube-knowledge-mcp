import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf } from '../helpers.js';

/**
 * The handler layer: rendering and structured output over mocked data access.
 *
 * Every tool now declares an output schema, which means it must return
 * structuredContent on every path — including the empty and partial-failure
 * paths that are easy to miss.
 */

vi.mock('../../src/utils/youtube.js', () => ({
  listVideos: vi.fn(),
  getVideoInfo: vi.fn(),
  getChapters: vi.fn(),
  getTranscript: vi.fn(),
  extractVideoId: vi.fn((value: string) => value),
}));
vi.mock('../../src/utils/storage.js', () => ({
  searchLibrary: vi.fn(),
  getLibraryItem: vi.fn(),
  deleteLibraryItem: vi.fn(),
  updateLibraryTags: vi.fn(),
  rebuildSearchIndex: vi.fn(),
}));

import { getChapters, getTranscript, getVideoInfo, listVideos } from '../../src/utils/youtube.js';
import {
  deleteLibraryItem,
  getLibraryItem,
  rebuildSearchIndex,
  searchLibrary,
  updateLibraryTags,
} from '../../src/utils/storage.js';
import { fetchVideosHandler } from '../../src/tools/fetch-videos.js';
import { digestPlaylistHandler, getTranscriptsHandler } from '../../src/tools/batch.js';
import {
  deleteLibraryItemHandler,
  getLibraryItemHandler,
  rebuildLibraryIndexHandler,
  searchLibraryHandler,
  updateLibraryTagsHandler,
} from '../../src/tools/library.js';

const VIDEO_LIST = [
  {
    id: 'v1',
    title: 'First video',
    duration: 120,
    durationFormatted: '2:00',
    uploadDate: '2024-01-01',
    url: 'https://www.youtube.com/watch?v=v1',
  },
];

const TRANSCRIPT = {
  transcript: 'hello world',
  segments: [{ start: 0, end: 2, text: 'hello world' }],
  language: 'en',
  videoId: 'v1',
  cached: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetch_videos', () => {
  it('renders the listing and reports pagination', async () => {
    vi.mocked(listVideos).mockResolvedValue(VIDEO_LIST);

    const result = await fetchVideosHandler({ url: 'https://youtube.com/@x', limit: 20 });

    expect(textOf(result)).toContain('First video');
    expect(result.structuredContent).toMatchObject({
      source: 'https://youtube.com/@x',
      total: 1,
      count: 1,
      hasMore: false,
    });
  });

  it('still returns structured output when nothing is found', async () => {
    vi.mocked(listVideos).mockResolvedValue([]);

    const result = await fetchVideosHandler({ url: 'https://youtube.com/@x', limit: 20 });

    expect(result.structuredContent).toMatchObject({ videos: [], total: 0 });
  });
});

describe('get_transcripts', () => {
  it('fetches several videos and reports how many succeeded', async () => {
    vi.mocked(getTranscript).mockResolvedValue(TRANSCRIPT);

    const result = await getTranscriptsHandler({
      videos: ['v1', 'v2'],
      language: 'en',
      maxCharsPerVideo: 4000,
    });

    expect(textOf(result)).toContain('2 of 2 transcripts retrieved');
    expect(result.structuredContent).toMatchObject({ requested: 2, succeeded: 2 });
  });

  it('reports a failing video individually instead of losing the batch', async () => {
    vi.mocked(getTranscript)
      .mockResolvedValueOnce(TRANSCRIPT)
      .mockRejectedValueOnce(new Error('no captions'));

    const result = await getTranscriptsHandler({
      videos: ['v1', 'v2'],
      language: 'en',
      maxCharsPerVideo: 4000,
    });

    expect(textOf(result)).toContain('1 of 2 transcripts retrieved');
    const structured = result.structuredContent as { results: { error?: string }[] };
    expect(structured.results[1]?.error).toBeTruthy();
  });

  it('caps each transcript so a batch cannot flood the context', async () => {
    vi.mocked(getTranscript).mockResolvedValue({
      ...TRANSCRIPT,
      segments: [{ start: 0, end: 5, text: 'word '.repeat(500).trim() }],
    });

    const result = await getTranscriptsHandler({
      videos: ['v1'],
      language: 'en',
      maxCharsPerVideo: 200,
    });

    expect(textOf(result)).toContain('Truncated');
    const structured = result.structuredContent as { results: { truncated?: boolean }[] };
    expect(structured.results[0]?.truncated).toBe(true);
  });
});

describe('digest_playlist', () => {
  it('reports an empty playlist without failing', async () => {
    vi.mocked(listVideos).mockResolvedValue([]);

    const result = await digestPlaylistHandler({
      url: 'https://youtube.com/playlist?list=x',
      limit: 10,
      includeChapters: false,
      includeTranscriptStats: false,
    });

    expect(textOf(result)).toContain('no videos');
    expect(result.structuredContent).toMatchObject({ count: 0, videos: [] });
  });

  it('surveys each video and folds in metadata', async () => {
    vi.mocked(listVideos).mockResolvedValue(VIDEO_LIST);
    vi.mocked(getVideoInfo).mockResolvedValue({
      id: 'v1',
      title: 'First video',
      channel: 'Chan',
      duration: 120,
      durationFormatted: '2:00',
      uploadDate: '2024-01-01',
      description: '',
      tags: [],
      url: 'https://www.youtube.com/watch?v=v1',
      thumbnailUrl: '',
      viewCount: 4242,
      likeCount: 0,
      commentCount: 0,
    });

    const result = await digestPlaylistHandler({
      url: 'https://youtube.com/playlist?list=x',
      limit: 10,
      includeChapters: false,
      includeTranscriptStats: false,
    });

    expect(textOf(result)).toContain('4,242 views');
    const structured = result.structuredContent as { videos: { viewCount?: number }[] };
    expect(structured.videos[0]?.viewCount).toBe(4242);
  });

  it('continues when per-video metadata is unavailable', async () => {
    vi.mocked(listVideos).mockResolvedValue(VIDEO_LIST);
    vi.mocked(getVideoInfo).mockRejectedValue(new Error('private'));

    const result = await digestPlaylistHandler({
      url: 'https://youtube.com/playlist?list=x',
      limit: 10,
      includeChapters: false,
      includeTranscriptStats: false,
    });

    expect(result.structuredContent).toMatchObject({ count: 1 });
  });

  it('records why a transcript was unavailable when stats are requested', async () => {
    vi.mocked(listVideos).mockResolvedValue(VIDEO_LIST);
    vi.mocked(getVideoInfo).mockRejectedValue(new Error('nope'));
    vi.mocked(getTranscript).mockRejectedValue(new Error('no captions'));

    const result = await digestPlaylistHandler({
      url: 'https://youtube.com/playlist?list=x',
      limit: 10,
      includeChapters: false,
      includeTranscriptStats: true,
    });

    const structured = result.structuredContent as { videos: { transcriptError?: string }[] };
    expect(structured.videos[0]?.transcriptError).toBeTruthy();
  });
});

describe('library handlers', () => {
  it('renders a saved item with its metadata and body', async () => {
    vi.mocked(getLibraryItem).mockResolvedValue({
      metadata: {
        videoId: 'v1',
        title: 'Saved title',
        channel: 'Chan',
        url: 'https://youtube.com/watch?v=v1',
        tags: ['a'],
        dateSaved: '2026-01-01T00:00:00.000Z',
        hasTranscript: true,
        hasSummary: true,
        hasSkill: false,
      },
      summary: '# Body',
    });

    const result = await getLibraryItemHandler({ videoId: 'v1' });

    expect(textOf(result)).toContain('Saved title');
    expect(textOf(result)).toContain('# Body');
    expect(result.structuredContent).toMatchObject({ summary: '# Body' });
  });

  it('explains an empty search rather than returning a bare list', async () => {
    vi.mocked(searchLibrary).mockResolvedValue({ hits: [], total: 0 });

    const result = await searchLibraryHandler({ query: 'nothing', limit: 10, offset: 0 });

    expect(textOf(result)).toContain('No saved notes match');
    expect(result.structuredContent).toMatchObject({ hits: [], total: 0 });
  });

  it('renders search hits with the call needed to read them', async () => {
    vi.mocked(searchLibrary).mockResolvedValue({
      hits: [
        {
          id: 'v1:summary',
          videoId: 'v1',
          title: 'Hit',
          kind: 'summary',
          score: 1.2,
          excerpt: '…x…',
        },
      ],
      total: 1,
    });

    const result = await searchLibraryHandler({ query: 'x', limit: 10, offset: 0 });

    expect(textOf(result)).toContain('get_library_item videoId=v1');
    expect(result.structuredContent).toMatchObject({ total: 1 });
  });

  it('confirms what a delete removed', async () => {
    vi.mocked(deleteLibraryItem).mockResolvedValue({ deleted: ['summary'] });

    const result = await deleteLibraryItemHandler({ videoId: 'v1', contentType: 'summary' });

    expect(textOf(result)).toContain('Deleted summary for v1');
    expect(result.structuredContent).toMatchObject({ videoId: 'v1', deleted: ['summary'] });
  });

  it('reports the tags after an update', async () => {
    vi.mocked(updateLibraryTags).mockResolvedValue({
      videoId: 'v1',
      title: 'T',
      channel: '',
      url: '',
      tags: ['x', 'y'],
      dateSaved: '',
      hasTranscript: false,
      hasSummary: true,
      hasSkill: false,
    });

    const result = await updateLibraryTagsHandler({ videoId: 'v1', add: ['y'] });

    expect(textOf(result)).toContain('tags: x, y');
  });

  it('says so when an item has no tags left', async () => {
    vi.mocked(updateLibraryTags).mockResolvedValue({
      videoId: 'v1',
      title: 'T',
      channel: '',
      url: '',
      tags: [],
      dateSaved: '',
      hasTranscript: false,
      hasSummary: true,
      hasSkill: false,
    });

    expect(textOf(await updateLibraryTagsHandler({ videoId: 'v1', remove: ['x'] }))).toContain(
      'no tags'
    );
  });

  it('reports how many documents were reindexed', async () => {
    vi.mocked(rebuildSearchIndex).mockResolvedValue({ documents: 7 });

    const result = await rebuildLibraryIndexHandler();

    expect(textOf(result)).toContain('7 saved note(s)');
    expect(result.structuredContent).toMatchObject({ documents: 7 });
  });
});

describe('digest_playlist chapters and transcript stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listVideos).mockResolvedValue(VIDEO_LIST);
    vi.mocked(getVideoInfo).mockRejectedValue(new Error('metadata unavailable'));
  });

  const args = {
    url: 'https://youtube.com/playlist?list=x',
    limit: 10,
    includeChapters: true,
    includeTranscriptStats: false,
  };

  it('lists each chapter with its start time when asked', async () => {
    vi.mocked(getChapters).mockResolvedValue([
      {
        title: 'Intro',
        startTime: 0,
        endTime: 60,
        startTimeFormatted: '0:00',
        endTimeFormatted: '1:00',
      },
      {
        title: 'The Middle',
        startTime: 60,
        endTime: 120,
        startTimeFormatted: '1:00',
        endTimeFormatted: '2:00',
      },
    ]);

    const result = await digestPlaylistHandler(args);
    const structured = result.structuredContent as {
      videos: { chapters?: { title: string; startSeconds: number }[] }[];
    };

    expect(textOf(result)).toContain('0:00 Intro · 1:00 The Middle');
    expect(structured.videos[0]?.chapters).toEqual([
      { title: 'Intro', startSeconds: 0 },
      { title: 'The Middle', startSeconds: 60 },
    ]);
  });

  it('says nothing about chapters for a video that has none', async () => {
    vi.mocked(getChapters).mockResolvedValue([]);

    const result = await digestPlaylistHandler(args);
    const structured = result.structuredContent as { videos: { chapters?: unknown }[] };

    expect(textOf(result)).not.toContain('chapters:');
    expect(structured.videos[0]).not.toHaveProperty('chapters');
  });

  it('continues when chapters cannot be fetched at all', async () => {
    // Not every video exposes them, and that is not worth failing a digest over.
    vi.mocked(getChapters).mockRejectedValue(new Error('nope'));

    const result = await digestPlaylistHandler(args);

    expect(result.structuredContent).toMatchObject({ count: 1 });
  });

  it('counts transcript words when stats are requested', async () => {
    vi.mocked(getTranscript).mockResolvedValue({
      transcript: 'one two three four five',
      segments: [
        { start: 0, end: 2, text: 'one two three' },
        { start: 2, end: 4, text: 'four five' },
      ],
      language: 'en',
      videoId: 'v1',
      cached: false,
    });

    const result = await digestPlaylistHandler({
      ...args,
      includeChapters: false,
      includeTranscriptStats: true,
    });
    const structured = result.structuredContent as { videos: { transcriptWords?: number }[] };

    expect(textOf(result)).toContain('transcript: 5 words (en)');
    expect(structured.videos[0]?.transcriptWords).toBe(5);
  });

  it('skips both extras when neither is asked for', async () => {
    const result = await digestPlaylistHandler({
      ...args,
      includeChapters: false,
      includeTranscriptStats: false,
    });

    expect(getChapters).not.toHaveBeenCalled();
    expect(getTranscript).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ count: 1 });
  });
});

describe('get_library_item rendering', () => {
  const METADATA = {
    videoId: 'v1',
    title: 'A Talk',
    channel: 'Chan',
    url: 'https://www.youtube.com/watch?v=v1',
    tags: ['systems'],
    dateSaved: '2024-01-01T12:00:00.000Z',
    hasTranscript: false,
    hasSummary: true,
    hasSkill: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders both notes with their headings', async () => {
    vi.mocked(getLibraryItem).mockResolvedValue({
      metadata: METADATA,
      summary: 'The summary body',
      skill: 'The skill body',
    });

    const text = textOf(await getLibraryItemHandler({ videoId: 'v1' }));

    expect(text).toContain('## Summary');
    expect(text).toContain('The summary body');
    expect(text).toContain('## Skill');
    expect(text).toContain('The skill body');
  });

  it('shows the channel, tags and save date', async () => {
    vi.mocked(getLibraryItem).mockResolvedValue({ metadata: METADATA, summary: 'x' });

    const text = textOf(await getLibraryItemHandler({ videoId: 'v1' }));

    expect(text).toContain('by Chan');
    expect(text).toContain('tags: systems');
    expect(text).toContain('saved 2024-01-01');
  });

  it('omits the channel and tag lines when there are none', async () => {
    vi.mocked(getLibraryItem).mockResolvedValue({
      metadata: { ...METADATA, channel: '', tags: [] },
      summary: 'x',
    });

    const text = textOf(await getLibraryItemHandler({ videoId: 'v1' }));

    expect(text).not.toContain('by ');
    expect(text).not.toContain('tags:');
  });

  it('omits the section for a note that does not exist', async () => {
    vi.mocked(getLibraryItem).mockResolvedValue({ metadata: METADATA, summary: 'only this' });

    const result = await getLibraryItemHandler({ videoId: 'v1' });

    expect(textOf(result)).not.toContain('## Skill');
    expect(result.structuredContent).not.toHaveProperty('skill');
    expect(result.structuredContent).toMatchObject({ summary: 'only this' });
  });
});
