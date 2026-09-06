import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/youtube-video.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/youtube-video.js')>();
  return { ...actual, getComments: vi.fn(), getVideoDetails: vi.fn() };
});

import { getComments, getVideoDetails } from '../../src/utils/youtube-video.js';
import { getCommentsHandler } from '../../src/tools/get-comments.js';
import { toThreads } from '../../src/utils/comment-threads.js';

function rows(): Parameters<typeof toThreads>[0] {
  return [
    {
      id: 'c1',
      parent: 'root',
      author: 'YouTube',
      text: 'Great video!',
      like_count: 232_000,
      is_pinned: true,
    },
    { id: 'c1.1', parent: 'c1', author: 'Fan', text: 'Agreed', like_count: 4, timestamp: 100 },
    { id: 'c2', parent: 'root', author: 'User123', text: 'Very helpful', like_count: 500 },
  ];
}

function result(
  overrides: Partial<ReturnType<typeof toThreads>> = {},
  extra: Record<string, unknown> = {}
): Awaited<ReturnType<typeof getComments>> {
  const threaded = toThreads(rows());
  return {
    ...threaded,
    ...overrides,
    ranToExhaustion: true,
    commentsDisabled: false,
    extractedTotal: 3,
    ...extra,
  };
}

const ARGS = { video: 'test123', limit: 20, includeReplies: false, sort: 'top' as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVideoDetails).mockResolvedValue({
    uploadDate: '2026-01-01',
    durationSeconds: 60,
    chapters: [],
    commentCount: 3,
  });
});

describe('get_comments', () => {
  it('renders top-level comments with their reply counts', async () => {
    vi.mocked(getComments).mockResolvedValue(result());

    const text = textOf(await getCommentsHandler(ARGS));

    expect(text).toContain('YouTube');
    expect(text).toContain('(pinned)');
    expect(text).toContain('232000 likes · 1 replies');
    expect(text).toContain('Very helpful');
  });

  it('keeps replies instead of discarding them', async () => {
    // They were always fetched; the old handler filtered them out after paying.
    vi.mocked(getComments).mockResolvedValue(result());

    const structured = structuredOf(await getCommentsHandler({ ...ARGS, includeReplies: true }));
    const threads = structured.threads;

    expect(JSON.stringify(threads)).toContain('Agreed');
    expect(JSON.stringify(threads)).toContain('"parentId":"c1"');
  });

  it('omits threads unless asked, keeping the old shape intact', async () => {
    vi.mocked(getComments).mockResolvedValue(result());

    const structured = structuredOf(await getCommentsHandler(ARGS));

    expect(structured.threads).toBeUndefined();
    expect(JSON.stringify(structured.comments)).toContain('"author":"YouTube"');
  });

  it('takes the real total from the metadata pass, not from the comment read', async () => {
    // yt-dlp overwrites comment_count with what it extracted whenever
    // --write-comments is used, so the denominator must come from elsewhere.
    vi.mocked(getComments).mockResolvedValue(result());
    vi.mocked(getVideoDetails).mockResolvedValue({
      uploadDate: '2026-01-01',
      durationSeconds: 60,
      chapters: [],
      commentCount: 2_400_000,
    });

    const result_ = await getCommentsHandler(ARGS);

    expect(structuredOf(result_)).toMatchObject({
      coverage: { expected: 2_400_000, expectedSource: 'youtube:comment_count', complete: false },
    });
    expect(textOf(result_)).toContain('of about 2,400,000 comments');
    expect(textOf(result_)).toContain('Do not describe this as the full comment history');
  });

  it('is complete when it holds everything the video has', async () => {
    vi.mocked(getComments).mockResolvedValue(result());

    expect(structuredOf(await getCommentsHandler(ARGS))).toMatchObject({
      coverage: { complete: true, reason: 'COMPLETE' },
    });
  });

  it('reports a video with comments turned off as complete at zero', async () => {
    vi.mocked(getComments).mockResolvedValue({
      threads: [],
      rootCount: 0,
      replyCount: 0,
      orphanCount: 0,
      ranToExhaustion: false,
      commentsDisabled: true,
      extractedTotal: 0,
    });

    expect(structuredOf(await getCommentsHandler(ARGS))).toMatchObject({
      coverage: { complete: true, expected: 0 },
    });
  });

  it('does not claim completeness when the cap was binding', async () => {
    vi.mocked(getComments).mockResolvedValue(result({}, { extractedTotal: 3 }));

    const structured = structuredOf(await getCommentsHandler({ ...ARGS, limit: 3 }));

    expect(structured).toMatchObject({
      coverage: { complete: false, reason: 'CAP_REACHED', limitApplied: 3, sortApplied: 'top' },
    });
  });

  it('survives a metadata pass that fails, without inventing a total', async () => {
    vi.mocked(getComments).mockResolvedValue(result());
    vi.mocked(getVideoDetails).mockRejectedValue(new Error('bot check'));

    const structured = structuredOf(await getCommentsHandler(ARGS));

    expect(structured).toMatchObject({ coverage: { complete: false, reason: 'SOURCE_SILENT' } });
  });

  it('counts orphan replies so a truncated thread is visible', async () => {
    // A reply whose parent the cap cut away is kept and counted, never
    // dropped: silently losing data is the bug this release is about.
    vi.mocked(getComments).mockResolvedValue({
      ...toThreads([{ id: 'r1', parent: 'gone', author: 'A', text: 'orphan' }]),
      ranToExhaustion: true,
      commentsDisabled: false,
      extractedTotal: 1,
    });

    const structured = structuredOf(await getCommentsHandler(ARGS));
    expect(structured.orphanReplies).toBe(1);
  });
});
