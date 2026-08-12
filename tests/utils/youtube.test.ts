import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
  // runYtDlp narrows failures with `instanceof ExecaError`, so the mock needs a
  // real class to test against.
  ExecaError: class ExecaError extends Error {},
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

/**
 * getVideoInfo prints 13 pipe-delimited fields. Building the mock from a record
 * rather than a hand-written string is what keeps this suite honest: the old
 * version supplied only 8 fields, so view/like/comment counts silently parsed
 * as 0 and `toMatchObject` never noticed.
 */
const VIDEO_INFO_FIELDS = [
  'id',
  'title',
  'channel',
  'duration',
  'uploadDate',
  'description',
  'tagsJson',
  'thumbnail',
  'viewCount',
  'likeCount',
  'commentCount',
  'availability',
  'liveStatus',
] as const;

function videoInfoStdout(
  overrides: Partial<Record<(typeof VIDEO_INFO_FIELDS)[number], string>>
): string {
  const defaults: Record<(typeof VIDEO_INFO_FIELDS)[number], string> = {
    id: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    channel: 'Rick Astley',
    duration: '213',
    uploadDate: '20091025',
    description: 'Description',
    tagsJson: '["tag1","tag2"]',
    thumbnail: 'https://thumbnail.jpg',
    viewCount: '1600000000',
    likeCount: '17000000',
    commentCount: '2300000',
    availability: 'public',
    liveStatus: 'not_live',
  };
  const merged = { ...defaults, ...overrides };
  return VIDEO_INFO_FIELDS.map((field) => merged[field]).join('|||');
}

function execaSuccess(stdout: string): never {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    failed: false,
    command: '',
    escapedCommand: '',
    killed: false,
    timedOut: false,
  } as never;
}

describe('YouTube Utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getVideoInfo', () => {
    it('parses every field yt-dlp prints', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue(execaSuccess(videoInfoStdout({})));

      const { getVideoInfo } = await import('../../src/utils/youtube.js');
      const result = await getVideoInfo('dQw4w9WgXcQ');

      expect(result).toEqual({
        id: 'dQw4w9WgXcQ',
        title: 'Never Gonna Give You Up',
        channel: 'Rick Astley',
        duration: 213,
        durationFormatted: '3:33',
        uploadDate: '2009-10-25',
        description: 'Description',
        tags: ['tag1', 'tag2'],
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        thumbnailUrl: 'https://thumbnail.jpg',
        viewCount: 1_600_000_000,
        likeCount: 17_000_000,
        commentCount: 2_300_000,
      });
    });

    it.each([
      ['private', 'PRIVATE'],
      ['subscriber_only', 'MEMBERS_ONLY'],
      ['premium_only', 'PREMIUM_ONLY'],
      ['needs_auth', 'AGE_GATED'],
    ])(
      'reports availability %s as %s rather than returning a hollow row',
      async (availability, code) => {
        // `--ignore-no-formats-error` turns a refusal into a populated row, so the
        // restriction has to be caught here or it is silently returned as a video.
        const { execa } = await import('execa');
        vi.mocked(execa).mockResolvedValue(execaSuccess(videoInfoStdout({ availability })));

        const { getVideoInfo } = await import('../../src/utils/youtube.js');

        await expect(getVideoInfo('dQw4w9WgXcQ')).rejects.toMatchObject({ code });
      }
    );

    it('reports an upcoming premiere rather than a video with no content', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue(
        execaSuccess(videoInfoStdout({ liveStatus: 'is_upcoming', duration: 'NA' }))
      );

      const { getVideoInfo } = await import('../../src/utils/youtube.js');

      await expect(getVideoInfo('dQw4w9WgXcQ')).rejects.toMatchObject({ code: 'LIVE_NOT_ENDED' });
    });

    it('asks yt-dlp for the structured availability fields', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue(execaSuccess(videoInfoStdout({})));

      const { getVideoInfo } = await import('../../src/utils/youtube.js');
      await getVideoInfo('dQw4w9WgXcQ');

      expect(execa).toHaveBeenCalledWith(
        'yt-dlp',
        expect.arrayContaining([
          '--ignore-no-formats-error',
          expect.stringContaining('%(availability)s|||%(live_status)s'),
        ]),
        expect.anything()
      );
    });

    it('falls back to zero for absent counts', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue(
        execaSuccess(
          videoInfoStdout({ viewCount: 'NA', likeCount: 'NA', commentCount: 'NA', tagsJson: '[]' })
        )
      );

      const { getVideoInfo } = await import('../../src/utils/youtube.js');
      const result = await getVideoInfo('dQw4w9WgXcQ');

      expect(result).toMatchObject({ viewCount: 0, likeCount: 0, commentCount: 0, tags: [] });
    });

    it('accepts a full URL and applies a timeout to the yt-dlp call', async () => {
      const { execa } = await import('execa');
      const mockedExeca = vi.mocked(execa);
      mockedExeca.mockResolvedValue(execaSuccess(videoInfoStdout({ id: 'ABC123xyzAB' })));

      const { getVideoInfo } = await import('../../src/utils/youtube.js');
      const result = await getVideoInfo('https://www.youtube.com/watch?v=ABC123xyzAB');

      expect(result.id).toBe('ABC123xyzAB');
      expect(mockedExeca).toHaveBeenCalledWith(
        'yt-dlp',
        expect.arrayContaining(['https://www.youtube.com/watch?v=ABC123xyzAB']),
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });
  });

  describe('transcript cache', () => {
    /** Present the given JSON as the cache file for dQw4w9WgXcQ. */
    async function withCacheFile(contents: string): Promise<void> {
      const { existsSync } = await import('fs');
      const { readFile } = await import('fs/promises');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(contents);
    }

    const VALID = JSON.stringify({
      version: 2,
      videoId: 'dQw4w9WgXcQ',
      language: 'en',
      fetchedAt: new Date().toISOString(),
      segments: [{ start: 0, end: 2, text: 'hello there' }],
    });

    it('serves a well-formed cache without calling yt-dlp', async () => {
      await withCacheFile(VALID);

      const { getTranscript } = await import('../../src/utils/youtube.js');
      const result = await getTranscript('dQw4w9WgXcQ', 'en');

      expect(result).toMatchObject({ transcript: 'hello there', cached: true });
      const { execa } = await import('execa');
      expect(execa).not.toHaveBeenCalled();
    });

    it.each([
      ['a segment missing its timing', { start: 0, text: 'hello' }],
      ['a segment whose start is a string', { start: '0', end: 2, text: 'hello' }],
      ['a segment that is not an object', 'hello'],
    ])('refetches rather than trusting %s', async (_label, segment) => {
      // The old code checked only that `segments` was an array, so a corrupt
      // file was handed back and `start` reached deep-link building as
      // undefined. Refetching is the only safe reading of a broken cache.
      await withCacheFile(
        JSON.stringify({
          version: 2,
          videoId: 'dQw4w9WgXcQ',
          language: 'en',
          fetchedAt: new Date().toISOString(),
          segments: [segment],
        })
      );

      const { execa } = await import('execa');
      // Fail the refetch: what matters is that a refetch was attempted at all.
      vi.mocked(execa).mockRejectedValue(new Error('refetched'));

      const { getTranscript } = await import('../../src/utils/youtube.js');

      await expect(getTranscript('dQw4w9WgXcQ', 'en')).rejects.toThrow();
      expect(execa).toHaveBeenCalled();
    });
  });

  describe('listVideos', () => {
    it('lists videos from a playlist', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue(
        execaSuccess('vid1|||Title 1|||120|||20240101\nvid2|||Title 2|||180|||20240102')
      );

      const { listVideos } = await import('../../src/utils/youtube.js');
      const result = await listVideos('https://youtube.com/playlist?list=PLtest', 10);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'vid1',
        title: 'Title 1',
        duration: 120,
        durationFormatted: '2:00',
        uploadDate: '2024-01-01',
      });
    });
  });
});
