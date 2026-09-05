import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execa } from 'execa';

// Root-level, so every describe in this file starts from a clean mock — the
// call-index assertions below read mock.calls[0] and would otherwise pick up
// whatever the previous test left behind.
beforeEach(() => {
  vi.clearAllMocks();
});

vi.mock('execa', () => ({
  execa: vi.fn(),
  // runYtDlp narrows failures with `instanceof ExecaError`, so the mock needs a
  // real class to test against.
  ExecaError: class ExecaError extends Error {},
}));

// The transcript cache is written atomically through a file handle; its write
// is routed to the `writeFile` mock so the cache tests can read it back.
vi.mock('fs/promises', () => {
  const writeFile = vi.fn((_path: string, _data: unknown): Promise<void> => Promise.resolve());
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    writeFile,
    unlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(() =>
      Promise.resolve({
        writeFile: (data: unknown) => writeFile('handle', data),
        sync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      })
    ),
  };
});

// Only the two calls the code under test makes are faked; `realpathSync`
// stays real so path containment can resolve the (real) home directory.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(), readdirSync: vi.fn(() => []) };
});

/**
 * getVideoInfo asks for one JSON object with thirteen named fields. Building the
 * mock from a record rather than a hand-written string is what keeps this suite
 * honest: an older pipe-delimited version supplied only 8 fields, so view/like/
 * comment counts silently parsed as 0 and `toMatchObject` never noticed.
 *
 * Overrides are written the way yt-dlp writes them: numbers as numbers, and
 * `null` for a field it could not find.
 */
interface VideoInfoRow {
  id: string | null;
  title: string | null;
  channel: string | null;
  duration: number | null;
  upload_date: string | null;
  description: string | null;
  tags: unknown;
  thumbnail: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  availability: string | null;
  live_status: string | null;
}

function videoInfoStdout(overrides: Partial<VideoInfoRow>): string {
  const defaults: VideoInfoRow = {
    id: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    channel: 'Rick Astley',
    duration: 213,
    upload_date: '20091025',
    description: 'Description',
    tags: ['tag1', 'tag2'],
    thumbnail: 'https://thumbnail.jpg',
    view_count: 1600000000,
    like_count: 17000000,
    comment_count: 2300000,
    availability: 'public',
    live_status: 'not_live',
  };
  return JSON.stringify({ ...defaults, ...overrides });
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
        execaSuccess(videoInfoStdout({ live_status: 'is_upcoming', duration: null }))
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
          expect.stringContaining('availability,live_status})j'),
        ]),
        expect.anything()
      );
    });

    it('falls back to zero for absent counts', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue(
        execaSuccess(
          videoInfoStdout({ view_count: null, like_count: null, comment_count: null, tags: [] })
        )
      );

      const { getVideoInfo } = await import('../../src/utils/youtube.js');
      const result = await getVideoInfo('dQw4w9WgXcQ');

      expect(result).toMatchObject({ viewCount: 0, likeCount: 0, commentCount: 0, tags: [] });
    });

    it('falls back to empty text and zero when yt-dlp reports null fields', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue(
        execaSuccess(
          videoInfoStdout({
            id: null,
            title: null,
            channel: null,
            description: null,
            thumbnail: null,
            upload_date: null,
            duration: null,
            availability: null,
            live_status: null,
          })
        )
      );

      const { getVideoInfo } = await import('../../src/utils/youtube.js');

      expect(await getVideoInfo('dQw4w9WgXcQ')).toMatchObject({
        id: 'dQw4w9WgXcQ',
        title: '',
        channel: '',
        description: '',
        thumbnailUrl: '',
        uploadDate: '',
        duration: 0,
      });
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
      const result = await getTranscript('dQw4w9WgXcQ', { language: 'en' });

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

      await expect(getTranscript('dQw4w9WgXcQ', { language: 'en' })).rejects.toThrow();
      expect(execa).toHaveBeenCalled();
    });
  });

  describe('listVideos', () => {
    it('lists videos from a playlist', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue(
        execaSuccess(
          [
            JSON.stringify({
              id: 'vid00000001',
              title: 'Title 1',
              duration: 120,
              upload_date: '20240101',
              view_count: 54000,
              thumbnails: [
                { url: 'https://i.ytimg.com/vi/vid00000001/hq720.jpg', width: 360, height: 202 },
                {
                  url: 'https://i.ytimg.com/vi/vid00000001/hq720.jpg?big',
                  width: 720,
                  height: 404,
                },
              ],
            }),
            JSON.stringify({
              id: 'vid00000002',
              title: 'Title 2',
              duration: 180,
              upload_date: '20240102',
            }),
          ].join('\n')
        )
      );

      const { listVideos } = await import('../../src/utils/youtube.js');
      const result = await listVideos('https://youtube.com/playlist?list=PLtest', 10);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'vid00000001',
        title: 'Title 1',
        duration: 120,
        durationFormatted: '2:00',
        uploadDate: '2024-01-01',
        thumbnailUrl: 'https://i.ytimg.com/vi/vid00000001/hq720.jpg?big',
        viewCount: 54000,
      });
      expect(result[1]?.thumbnailUrl).toBeUndefined();
    });

    it('passes the listing target after a -- terminator', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue(execaSuccess(''));

      const { listVideos } = await import('../../src/utils/youtube.js');
      await listVideos('https://youtube.com/playlist?list=PLtest', 10);

      const argv = vi.mocked(execa).mock.calls[0]?.[1];
      expect(Array.isArray(argv) ? argv.slice(-2) : []).toEqual([
        '--',
        'https://youtube.com/playlist?list=PLtest',
      ]);
    });

    it.each([
      ['a handle', '@creator', 'https://www.youtube.com/@creator'],
      [
        'a channel id',
        'UCXuqSBlHAE6Xw-yeJA0Tunw',
        'https://www.youtube.com/channel/UCXuqSBlHAE6Xw-yeJA0Tunw',
      ],
      ['a scheme-less URL', 'youtube.com/@creator/videos', 'https://youtube.com/@creator/videos'],
    ])('resolves %s to a YouTube URL', async (_label, input, expected) => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue(execaSuccess(''));

      const { listVideos } = await import('../../src/utils/youtube.js');
      await listVideos(input, 5);

      const argv = vi.mocked(execa).mock.calls[0]?.[1];
      expect(Array.isArray(argv) ? argv.at(-1) : undefined).toBe(expected);
    });

    // A value that starts with a dash used to land in yt-dlp's option parser.
    it.each([
      ['a flag disguised as a URL', '--config-locations=/tmp/evil'],
      ['another host', 'https://example.com/playlist'],
      ['a bare word', 'cats'],
    ])('refuses %s before spawning yt-dlp', async (_label, input) => {
      const { execa } = await import('execa');
      const { listVideos } = await import('../../src/utils/youtube.js');

      await expect(listVideos(input, 5)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(execa).not.toHaveBeenCalled();
    });
  });
});

describe('getVideoDetails', () => {
  it('reports zero duration and no chapters when yt-dlp omits them', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(execaSuccess(JSON.stringify({})));

    const { getVideoDetails } = await import('../../src/utils/youtube.js');

    expect(await getVideoDetails('dQw4w9WgXcQ')).toEqual({
      uploadDate: '',
      durationSeconds: 0,
      chapters: [],
    });
  });
});

describe('extractVideoId', () => {
  it('truncates a long unrecognised value rather than echoing it whole', async () => {
    const { extractVideoId } = await import('../../src/utils/youtube.js');
    const junk = 'x'.repeat(300);

    const error = (() => {
      try {
        extractVideoId(junk);
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error?.message.length).toBeLessThan(150);
    expect(error?.message).toContain('...');
  });

  it.each([
    ['a bare ID', 'dQw4w9WgXcQ'],
    ['a watch URL', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a watch URL with extra parameters', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'],
    ['a youtu.be short link', 'https://youtu.be/dQw4w9WgXcQ'],
    ['an embed URL', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['a /v/ URL', 'https://www.youtube.com/v/dQw4w9WgXcQ'],
    ['a Shorts URL', 'https://www.youtube.com/shorts/dQw4w9WgXcQ'],
  ])('reads %s', async (_label, input) => {
    const { extractVideoId } = await import('../../src/utils/youtube.js');
    expect(extractVideoId(input)).toBe('dQw4w9WgXcQ');
  });

  it.each(['', 'not a url', 'https://vimeo.com/12345', 'https://www.youtube.com/watch?v=short'])(
    'rejects %s',
    async (input) => {
      const { extractVideoId } = await import('../../src/utils/youtube.js');
      expect(() => extractVideoId(input)).toThrow(/Could not extract video ID/);
    }
  );
});

describe('listFormats', () => {
  it('maps yt-dlp formats onto the shape the tool reports', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        JSON.stringify({
          formats: [
            {
              format_id: '18',
              ext: 'mp4',
              resolution: '640x360',
              fps: 30,
              vcodec: 'avc1',
              acodec: 'mp4a',
              filesize: 1024,
              format_note: 'medium',
            },
          ],
        })
      )
    );

    const { listFormats } = await import('../../src/utils/youtube.js');

    expect(await listFormats('dQw4w9WgXcQ')).toEqual([
      {
        formatId: '18',
        ext: 'mp4',
        resolution: '640x360',
        fps: 30,
        vcodec: 'avc1',
        acodec: 'mp4a',
        filesize: 1024,
        note: 'medium',
      },
    ]);
  });

  it('drops storyboard entries, which are not playable formats', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        JSON.stringify({
          formats: [
            { format_id: 'sb0', ext: 'mhtml' },
            { format_id: '18', ext: 'mp4' },
          ],
        })
      )
    );

    const { listFormats } = await import('../../src/utils/youtube.js');
    const formats = await listFormats('dQw4w9WgXcQ');

    expect(formats.map((f) => f.formatId)).toEqual(['18']);
  });

  it('builds a resolution from width and height when yt-dlp omits it', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        JSON.stringify({ formats: [{ format_id: '137', ext: 'mp4', width: 1920, height: 1080 }] })
      )
    );

    const { listFormats } = await import('../../src/utils/youtube.js');

    expect((await listFormats('dQw4w9WgXcQ'))[0]?.resolution).toBe('1920x1080');
  });

  it('calls an entry with no dimensions audio only', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(JSON.stringify({ formats: [{ format_id: '140', ext: 'm4a' }] }))
    );

    const { listFormats } = await import('../../src/utils/youtube.js');
    const [format] = await listFormats('dQw4w9WgXcQ');

    expect(format).toMatchObject({ resolution: 'audio only', vcodec: 'none', acodec: 'none' });
  });

  it('falls back to the approximate size when the exact one is absent', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        JSON.stringify({ formats: [{ format_id: '18', ext: 'mp4', filesize_approx: 2048 }] })
      )
    );

    const { listFormats } = await import('../../src/utils/youtube.js');

    expect((await listFormats('dQw4w9WgXcQ'))[0]?.filesize).toBe(2048);
  });

  it('returns nothing when yt-dlp reports no formats', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(execaSuccess(JSON.stringify({})));

    const { listFormats } = await import('../../src/utils/youtube.js');

    expect(await listFormats('dQw4w9WgXcQ')).toEqual([]);
  });
});

describe('downloadVideo', () => {
  /** One download run, whose after_move print reports the title and the final path. */
  function downloaded(filepath: string, title = 'A Talk'): string {
    return JSON.stringify({ title, filepath });
  }

  function argvOf(call: number): string[] {
    const argv = vi.mocked(execa).mock.calls[call]?.[1];
    return Array.isArray(argv) ? argv : [];
  }

  it('reports what it downloaded and where yt-dlp put it, from a single run', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValueOnce(
      execaSuccess(downloaded('/home/u/.youtube-knowledge/downloads/A Talk.mp4'))
    );

    const { downloadVideo } = await import('../../src/utils/youtube.js');

    expect(await downloadVideo('dQw4w9WgXcQ', 'best')).toEqual({
      videoId: 'dQw4w9WgXcQ',
      title: 'A Talk',
      filePath: '/home/u/.youtube-knowledge/downloads/A Talk.mp4',
      format: 'best',
    });
    // The title and the path used to cost two extra spawns each.
    expect(execa).toHaveBeenCalledTimes(1);
    expect(argvOf(0)).toContain('after_move:%(.{title,filepath})j');
  });

  it('lets a quality preset win over an explicit formatId', async () => {
    vi.mocked(execa).mockResolvedValueOnce(execaSuccess(downloaded('/downloads/A Talk.mp4')));

    const { downloadVideo } = await import('../../src/utils/youtube.js');
    const result = await downloadVideo('dQw4w9WgXcQ', '137', undefined, '720p');

    expect(argvOf(0).join(' ')).toContain('height<=720');
    expect(result.format).toBe('720p');
  });

  it('falls back to best when an explicitly requested format does not exist', async () => {
    vi.mocked(execa)
      .mockRejectedValueOnce(new Error('requested format not available'))
      .mockResolvedValueOnce(execaSuccess(downloaded('/downloads/A Talk.mp4')));

    const { downloadVideo } = await import('../../src/utils/youtube.js');
    const result = await downloadVideo('dQw4w9WgXcQ', '999');

    expect(result.filePath).toBe('/downloads/A Talk.mp4');
    expect(argvOf(1).join(' ')).toContain('bestvideo*+bestaudio');
  });

  it('does not fall back when a preset fails, since presets already chain', async () => {
    vi.mocked(execa).mockRejectedValueOnce(new Error('nothing works'));

    const { downloadVideo } = await import('../../src/utils/youtube.js');

    await expect(downloadVideo('dQw4w9WgXcQ', 'best', undefined, '1080p')).rejects.toThrow();
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when "best" itself fails, as there is nothing broader', async () => {
    vi.mocked(execa).mockRejectedValueOnce(new Error('nothing works'));

    const { downloadVideo } = await import('../../src/utils/youtube.js');

    await expect(downloadVideo('dQw4w9WgXcQ', 'best')).rejects.toThrow();
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });

  it('prefers codecs that merge cleanly into MP4', async () => {
    vi.mocked(execa).mockResolvedValueOnce(execaSuccess(downloaded('/downloads/A Talk.mp4')));

    const { downloadVideo } = await import('../../src/utils/youtube.js');
    await downloadVideo('dQw4w9WgXcQ', 'best');

    expect(argvOf(0)).toContain('vcodec:h264,acodec:m4a');
    expect(argvOf(0)).toContain('--merge-output-format');
  });

  it('reads the last line of the after_move output, ignoring anything printed before it', async () => {
    vi.mocked(execa).mockResolvedValueOnce(
      execaSuccess(
        `{"title":"A Talk","filepath":"/downloads/A Talk.webm"}\n${downloaded('/downloads/A Talk.mp4')}`
      )
    );

    const { downloadVideo } = await import('../../src/utils/youtube.js');

    expect((await downloadVideo('dQw4w9WgXcQ', 'best')).filePath).toBe('/downloads/A Talk.mp4');
  });

  it('reports an empty title when the after_move line carries none', async () => {
    vi.mocked(execa).mockResolvedValueOnce(execaSuccess(JSON.stringify({ filepath: '/d/x.mp4' })));

    const { downloadVideo } = await import('../../src/utils/youtube.js');

    expect(await downloadVideo('dQw4w9WgXcQ', 'best')).toMatchObject({
      title: '',
      filePath: '/d/x.mp4',
    });
  });

  it('fails clearly when yt-dlp printed no after_move line', async () => {
    vi.mocked(execa).mockResolvedValueOnce(execaSuccess(''));

    const { downloadVideo } = await import('../../src/utils/youtube.js');

    await expect(downloadVideo('dQw4w9WgXcQ', 'best')).rejects.toMatchObject({
      code: 'YTDLP_FAILED',
    });
  });

  it('reports an unreadable after_move line as a malformed response', async () => {
    vi.mocked(execa).mockResolvedValueOnce(execaSuccess('not json'));

    const { downloadVideo } = await import('../../src/utils/youtube.js');

    await expect(downloadVideo('dQw4w9WgXcQ', 'best')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('refuses an output directory outside the home directory', async () => {
    const { downloadVideo } = await import('../../src/utils/youtube.js');

    await expect(downloadVideo('dQw4w9WgXcQ', 'best', '/etc')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('searchVideos', () => {
  it('reads newline-delimited results', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        [
          JSON.stringify({
            id: 'aaaaaaaaaaa',
            title: 'First',
            duration: 90,
            channel: 'Chan',
            view_count: 10,
            url: 'https://youtu.be/aaaaaaaaaaa',
          }),
          JSON.stringify({ id: 'bbbbbbbbbbb' }),
        ].join('\n')
      )
    );

    const { searchVideos } = await import('../../src/utils/youtube.js');
    const results = await searchVideos('systems', 2);

    expect(results[0]).toMatchObject({
      id: 'aaaaaaaaaaa',
      title: 'First',
      durationFormatted: '1:30',
      viewCount: 10,
    });
    // A row with only an id must still be usable rather than dropped.
    expect(results[1]).toMatchObject({
      id: 'bbbbbbbbbbb',
      title: 'Unknown',
      channel: 'Unknown',
      url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
    });
  });

  it('skips a row with no id rather than emitting a broken result', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        [JSON.stringify({ title: 'no id here' }), JSON.stringify({ id: 'ccccccccccc' })].join('\n')
      )
    );

    const { searchVideos } = await import('../../src/utils/youtube.js');

    expect(await searchVideos('q')).toHaveLength(1);
  });
});

describe('getChapters', () => {
  it('formats each chapter boundary', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        JSON.stringify({
          chapters: [{ title: 'Intro', start_time: 0, end_time: 62.5 }],
        })
      )
    );

    const { getChapters } = await import('../../src/utils/youtube.js');

    expect(await getChapters('dQw4w9WgXcQ')).toEqual([
      {
        title: 'Intro',
        startTime: 0,
        startTimeFormatted: '0:00',
        endTime: 62.5,
        endTimeFormatted: '1:02',
      },
    ]);
  });

  it('returns nothing for a video without chapters', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(execaSuccess(JSON.stringify({})));

    const { getChapters } = await import('../../src/utils/youtube.js');

    expect(await getChapters('dQw4w9WgXcQ')).toEqual([]);
  });
});

describe('getComments', () => {
  it('keeps only top-level comments', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        JSON.stringify({
          comments: [
            { author: 'A', text: 'top level', like_count: 5, is_pinned: true, parent: 'root' },
            { author: 'B', text: 'a reply', parent: 'abc123' },
          ],
        })
      )
    );

    const { getComments } = await import('../../src/utils/youtube.js');

    expect(await getComments('dQw4w9WgXcQ')).toEqual([
      { author: 'A', text: 'top level', likeCount: 5, isPinned: true },
    ]);
  });

  it('honours the limit', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        JSON.stringify({
          comments: Array.from({ length: 10 }, (_, i) => ({
            author: `A${i}`,
            text: 'x',
            parent: 'root',
          })),
        })
      )
    );

    const { getComments } = await import('../../src/utils/youtube.js');

    expect(await getComments('dQw4w9WgXcQ', 3)).toHaveLength(3);
  });

  it('fills in defaults for a sparse comment', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(JSON.stringify({ comments: [{ parent: 'root' }] }))
    );

    const { getComments } = await import('../../src/utils/youtube.js');

    expect(await getComments('dQw4w9WgXcQ')).toEqual([
      { author: 'Unknown', text: '', likeCount: 0, isPinned: false },
    ]);
  });

  it('returns nothing when comments are disabled', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(execaSuccess(JSON.stringify({})));

    const { getComments } = await import('../../src/utils/youtube.js');

    expect(await getComments('dQw4w9WgXcQ')).toEqual([]);
  });
});

describe('searchChannels', () => {
  it('maps channel rows, preferring the channel name over the title', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        JSON.stringify({
          channel: 'Real Name',
          title: 'Fallback Title',
          channel_id: 'UC123',
          uploader_id: '@handle',
          channel_follower_count: 1000,
          channel_url: 'https://youtube.com/@handle',
          description: 'about',
        })
      )
    );

    const { searchChannels } = await import('../../src/utils/youtube.js');

    expect(await searchChannels('q')).toEqual([
      {
        name: 'Real Name',
        channelId: 'UC123',
        handle: '@handle',
        subscriberCount: 1000,
        channelUrl: 'https://youtube.com/@handle',
        description: 'about',
      },
    ]);
  });

  it('falls back through title, then to Unknown', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess([JSON.stringify({ title: 'Only Title' }), JSON.stringify({})].join('\n'))
    );

    const { searchChannels } = await import('../../src/utils/youtube.js');
    const results = await searchChannels('q');

    expect(results[0]?.name).toBe('Only Title');
    expect(results[1]?.name).toBe('Unknown');
  });
});

describe('getPlaylistInfo', () => {
  it('maps playlist metadata', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        JSON.stringify({
          id: 'PL123',
          title: 'A Playlist',
          channel: 'Chan',
          uploader_id: '@chan',
          channel_url: 'https://youtube.com/@chan',
          playlist_count: 12,
          modified_date: '20240115',
          webpage_url: 'https://youtube.com/playlist?list=PL123',
          description: 'about',
        })
      )
    );

    const { getPlaylistInfo } = await import('../../src/utils/youtube.js');

    expect(await getPlaylistInfo('https://youtube.com/playlist?list=PL123')).toMatchObject({
      id: 'PL123',
      title: 'A Playlist',
      videoCount: 12,
      lastModified: '2024-01-15',
    });
  });

  it('falls back to the URL it was given when yt-dlp reports none', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(execaSuccess(JSON.stringify({})));

    const { getPlaylistInfo } = await import('../../src/utils/youtube.js');

    expect(await getPlaylistInfo('https://youtube.com/playlist?list=PL999')).toMatchObject({
      title: 'Unknown',
      url: 'https://youtube.com/playlist?list=PL999',
      lastModified: '',
    });
  });

  // yt-dlp's generic extractor would fetch this host on the caller's behalf.
  it('rejects a URL on another host before spawning anything', async () => {
    const { execa } = await import('execa');
    const { getPlaylistInfo } = await import('../../src/utils/youtube.js');

    await expect(getPlaylistInfo('https://example.com/list')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(execa).not.toHaveBeenCalled();
  });
});

describe('getChannelInfo', () => {
  it.each([
    ['a handle with @', '@creator', 'https://www.youtube.com/@creator'],
    ['a bare handle', 'creator', 'https://www.youtube.com/@creator'],
    ['a full URL', 'https://www.youtube.com/c/creator', 'https://www.youtube.com/c/creator'],
  ])('builds the channel URL from %s', async (_label, input, expected) => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(execaSuccess(JSON.stringify({ channel: 'Creator' })));

    const { getChannelInfo } = await import('../../src/utils/youtube.js');
    await getChannelInfo(input);

    const argv = vi.mocked(execa).mock.calls[0]?.[1];
    expect(Array.isArray(argv) && argv).toContain(expected);
  });

  it.each([
    ['an internal address', 'http://10.0.0.1/admin'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/'],
    ['another site', 'https://example.com/@creator'],
  ])('refuses %s without spawning yt-dlp', async (_label, input) => {
    const { execa } = await import('execa');
    const { getChannelInfo } = await import('../../src/utils/youtube.js');

    await expect(getChannelInfo(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(execa).not.toHaveBeenCalled();
  });

  it('reports Unknown rather than an empty name', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(execaSuccess(JSON.stringify({})));

    const { getChannelInfo } = await import('../../src/utils/youtube.js');
    const info = await getChannelInfo('@x');

    expect(info.name).toBe('Unknown');
    expect(info).not.toHaveProperty('avatarUrl');
    expect(info).not.toHaveProperty('bannerUrl');
  });

  it('reads the avatar and banner from the channel listing', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue(
      execaSuccess(
        JSON.stringify({
          channel: 'Creator',
          thumbnails: [
            {
              id: '0',
              url: 'https://yt3.googleusercontent.com/banner=w1060',
              width: 1060,
              height: 175,
            },
            { id: 'banner_uncropped', url: 'https://yt3.googleusercontent.com/banner=s0' },
            {
              id: '7',
              url: 'https://yt3.googleusercontent.com/avatar=s900',
              width: 900,
              height: 900,
            },
            { id: 'avatar_uncropped', url: 'https://yt3.googleusercontent.com/avatar=s0' },
          ],
        })
      )
    );

    const { getChannelInfo } = await import('../../src/utils/youtube.js');

    expect(await getChannelInfo('@creator')).toMatchObject({
      avatarUrl: 'https://yt3.googleusercontent.com/avatar=s0',
      bannerUrl: 'https://yt3.googleusercontent.com/banner=s0',
    });
  });
});

describe('getTranscript (fetch path)', () => {
  const VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
hello there

00:00:02.000 --> 00:00:04.000
and welcome
`;

  /**
   * No cache on disk, and only the named subtitle file present afterwards.
   * `existsSync` is consulted first for the cache and then for each candidate.
   */
  async function withSubtitleFile(name: string | undefined, contents = VTT): Promise<void> {
    const { existsSync } = await import('fs');
    const { readFile } = await import('fs/promises');

    vi.mocked(existsSync).mockImplementation(
      (path) => name !== undefined && String(path).endsWith(name)
    );
    vi.mocked(readFile).mockResolvedValue(contents);
    vi.mocked(execa).mockResolvedValue(execaSuccess(''));
  }

  it('parses the fetched captions into timed segments', async () => {
    await withSubtitleFile('.en.vtt');

    const { getTranscript } = await import('../../src/utils/youtube.js');
    const result = await getTranscript('dQw4w9WgXcQ', { language: 'en' });

    expect(result).toMatchObject({
      transcript: 'hello there and welcome',
      language: 'en',
      videoId: 'dQw4w9WgXcQ',
      cached: false,
    });
    expect(result.segments[0]).toEqual({ start: 0, end: 2, text: 'hello there' });
  });

  it('writes the result to the cache in the versioned format', async () => {
    await withSubtitleFile('.en.vtt');
    const { writeFile } = await import('fs/promises');

    const { getTranscript } = await import('../../src/utils/youtube.js');
    await getTranscript('dQw4w9WgXcQ', { language: 'en' });

    const written = vi.mocked(writeFile).mock.calls[0]?.[1];
    expect(typeof written).toBe('string');
    expect(JSON.parse(typeof written === 'string' ? written : '{}')).toMatchObject({
      version: 2,
      videoId: 'dQw4w9WgXcQ',
      language: 'en',
    });
  });

  it('labels an auto-generated track as such', async () => {
    await withSubtitleFile('.en-orig.vtt');

    const { getTranscript } = await import('../../src/utils/youtube.js');

    expect((await getTranscript('dQw4w9WgXcQ', { language: 'en' })).language).toBe(
      'en (auto-generated)'
    );
  });

  it('falls back to the English track when the requested language is absent', async () => {
    await withSubtitleFile('.en.vtt');

    const { getTranscript } = await import('../../src/utils/youtube.js');

    expect((await getTranscript('dQw4w9WgXcQ', { language: 'fr' })).language).toBe('en');
  });

  it('bypasses a usable cache when refresh is set', async () => {
    const { existsSync } = await import('fs');
    const { readFile } = await import('fs/promises');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue(VTT);
    vi.mocked(execa).mockResolvedValue(execaSuccess(''));

    const { getTranscript } = await import('../../src/utils/youtube.js');
    const result = await getTranscript('dQw4w9WgXcQ', { language: 'en', refresh: true });

    expect(result.cached).toBe(false);
    expect(execa).toHaveBeenCalled();
  });

  describe('cache validity', () => {
    /** A cache file is on disk; `readFile` serves it first, then the fetched VTT. */
    async function withCachedEntry(entry: Record<string, unknown>): Promise<void> {
      const { existsSync } = await import('fs');
      const { readFile } = await import('fs/promises');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(entry)).mockResolvedValueOnce(VTT);
      vi.mocked(execa).mockResolvedValue(execaSuccess(''));
    }

    const FRESH = {
      videoId: 'dQw4w9WgXcQ',
      language: 'en',
      segments: [{ start: 0, end: 1, text: 'cached' }],
    };

    it('refetches a cache written by an older version', async () => {
      await withCachedEntry({ ...FRESH, version: 1, fetchedAt: new Date().toISOString() });

      const { getTranscript } = await import('../../src/utils/youtube.js');
      const result = await getTranscript('dQw4w9WgXcQ', { language: 'en' });

      expect(result.cached).toBe(false);
      expect(execa).toHaveBeenCalled();
    });

    it('refetches a cache older than the TTL', async () => {
      await withCachedEntry({ ...FRESH, version: 2, fetchedAt: '2000-01-01T00:00:00.000Z' });

      const { getTranscript } = await import('../../src/utils/youtube.js');
      const result = await getTranscript('dQw4w9WgXcQ', { language: 'en' });

      expect(result.cached).toBe(false);
      expect(execa).toHaveBeenCalled();
    });

    it('serves a fresh cache without spawning yt-dlp', async () => {
      await withCachedEntry({ ...FRESH, version: 2, fetchedAt: new Date().toISOString() });

      const { getTranscript } = await import('../../src/utils/youtube.js');
      const result = await getTranscript('dQw4w9WgXcQ', { language: 'en' });

      expect(result).toMatchObject({ cached: true, transcript: 'cached' });
      expect(execa).not.toHaveBeenCalled();
    });
  });

  it('still returns the transcript when the temporary subtitle file cannot be removed', async () => {
    await withSubtitleFile('.en.vtt');
    const { unlink } = await import('fs/promises');
    vi.mocked(unlink).mockRejectedValueOnce(new Error('EPERM'));

    const { getTranscript } = await import('../../src/utils/youtube.js');

    expect((await getTranscript('dQw4w9WgXcQ', { language: 'en' })).cached).toBe(false);
  });

  it('defaults to English when the options carry no language', async () => {
    await withSubtitleFile('.en.vtt');

    const { getTranscript } = await import('../../src/utils/youtube.js');
    await getTranscript('dQw4w9WgXcQ', {});

    const argv = vi.mocked(execa).mock.calls[0]?.[1];
    expect(Array.isArray(argv) && argv).toContain('en,en-orig');
  });

  it('rejects a language tag that is not one', async () => {
    const { getTranscript } = await import('../../src/utils/youtube.js');

    await expect(
      getTranscript('dQw4w9WgXcQ', { language: 'not a language' })
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  describe('when there are no captions', () => {
    /** yt-dlp writes no subtitle file, then the probe reports what exists. */
    async function withNoSubtitles(probe: string): Promise<void> {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(execa)
        .mockResolvedValueOnce(execaSuccess(''))
        .mockResolvedValueOnce(execaSuccess(probe));
    }

    it('names the languages that would work instead', async () => {
      await withNoSubtitles(
        JSON.stringify({ subtitles: { fr: [], es: [] }, automatic_captions: { de: [] } })
      );

      const { getTranscript } = await import('../../src/utils/youtube.js');
      const error = await getTranscript('dQw4w9WgXcQ', { language: 'en' }).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'NO_CAPTIONS' });
      expect(String((error as Error & { nextStep?: string }).nextStep)).toContain('de, es, fr');
    });

    it('hides the -orig duplicates yt-dlp reports alongside real tracks', async () => {
      await withNoSubtitles(JSON.stringify({ subtitles: { fr: [], 'fr-orig': [] } }));

      const { getTranscript } = await import('../../src/utils/youtube.js');
      const error = (await getTranscript('dQw4w9WgXcQ', { language: 'en' }).catch(
        (e: unknown) => e
      )) as Error & {
        nextStep?: string;
      };

      expect(error.nextStep).toContain('fr');
      expect(error.nextStep).not.toContain('fr-orig');
    });

    it('caps a very long language list rather than printing hundreds', async () => {
      const many = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`l${String(i).padStart(2, '0')}`, []])
      );
      await withNoSubtitles(JSON.stringify({ subtitles: many }));

      const { getTranscript } = await import('../../src/utils/youtube.js');
      const error = (await getTranscript('dQw4w9WgXcQ', { language: 'en' }).catch(
        (e: unknown) => e
      )) as Error & {
        nextStep?: string;
      };

      expect(error.nextStep).toContain('and 15 more');
    });

    it('says so plainly when the video has captions in no language at all', async () => {
      await withNoSubtitles(JSON.stringify({}));

      const { getTranscript } = await import('../../src/utils/youtube.js');
      const error = (await getTranscript('dQw4w9WgXcQ', { language: 'en' }).catch(
        (e: unknown) => e
      )) as Error;

      expect(error.message).toContain('no captions in any language');
    });

    it('still reports NO_CAPTIONS when the probe itself fails', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(execa)
        .mockResolvedValueOnce(execaSuccess(''))
        .mockRejectedValueOnce(new Error('probe failed'));

      const { getTranscript } = await import('../../src/utils/youtube.js');

      // The probe is a nicety; it must never mask the real problem.
      await expect(getTranscript('dQw4w9WgXcQ', { language: 'en' })).rejects.toMatchObject({
        code: 'NO_CAPTIONS',
      });
    });

    it('treats an empty caption file as no captions', async () => {
      await withSubtitleFile('.en.vtt', 'WEBVTT\n\n');
      vi.mocked(execa)
        .mockResolvedValueOnce(execaSuccess(''))
        .mockResolvedValueOnce(execaSuccess(JSON.stringify({})));

      const { getTranscript } = await import('../../src/utils/youtube.js');

      await expect(getTranscript('dQw4w9WgXcQ', { language: 'en' })).rejects.toMatchObject({
        code: 'NO_CAPTIONS',
      });
    });
  });

  it('passes a typed yt-dlp failure through rather than flattening it', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(execa).mockRejectedValue(new Error('/home/alice/secrets exploded'));

    const { getTranscript } = await import('../../src/utils/youtube.js');
    const error = (await getTranscript('dQw4w9WgXcQ', { language: 'en' }).catch(
      (e: unknown) => e
    )) as Error;

    // runYtDlp has already classified this; re-wrapping would discard the code
    // and the actionable next step it carries.
    expect(error).toMatchObject({ code: 'YTDLP_FAILED' });
    expect(error.message).not.toContain('alice');
  });

  it('wraps a failure that is not yt-dlp’s, naming the video and leaking nothing', async () => {
    const { existsSync } = await import('fs');
    const { readFile } = await import('fs/promises');
    vi.mocked(existsSync).mockImplementation((path) => String(path).endsWith('.en.vtt'));
    vi.mocked(execa).mockResolvedValue(execaSuccess(''));
    vi.mocked(readFile).mockRejectedValue(new Error('EACCES /home/alice/.cache'));

    const { getTranscript } = await import('../../src/utils/youtube.js');
    const error = (await getTranscript('dQw4w9WgXcQ', { language: 'en' }).catch(
      (e: unknown) => e
    )) as Error;

    expect(error.message).toContain('dQw4w9WgXcQ');
    expect(error.message).not.toContain('alice');
  });
});

describe('hasCachedTranscript', () => {
  it('reports whether anything is cached for the video, in any language', async () => {
    const { existsSync, readdirSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['dQw4w9WgXcQ.fr.json'] as never);

    const { hasCachedTranscript } = await import('../../src/utils/youtube.js');

    expect(hasCachedTranscript('dQw4w9WgXcQ')).toBe(true);
    expect(hasCachedTranscript('other-video')).toBe(false);
  });

  it('reports nothing cached when the directory does not exist yet', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(false);

    const { hasCachedTranscript } = await import('../../src/utils/youtube.js');

    expect(hasCachedTranscript('dQw4w9WgXcQ')).toBe(false);
  });
});

describe('duration and tag rendering', () => {
  it('shows hours for a video longer than an hour', async () => {
    vi.mocked(execa).mockResolvedValue(execaSuccess(videoInfoStdout({ duration: 3723 })));

    const { getVideoInfo } = await import('../../src/utils/youtube.js');

    expect((await getVideoInfo('dQw4w9WgXcQ')).durationFormatted).toBe('1:02:03');
  });

  it('treats a tags field that is not a list as none rather than failing the whole lookup', async () => {
    vi.mocked(execa).mockResolvedValue(execaSuccess(videoInfoStdout({ tags: 'not a list' })));

    const { getVideoInfo } = await import('../../src/utils/youtube.js');

    expect((await getVideoInfo('dQw4w9WgXcQ')).tags).toEqual([]);
  });

  it('drops tag entries that are not strings', async () => {
    vi.mocked(execa).mockResolvedValue(execaSuccess(videoInfoStdout({ tags: ['ok', 42, null] })));

    const { getVideoInfo } = await import('../../src/utils/youtube.js');

    expect((await getVideoInfo('dQw4w9WgXcQ')).tags).toEqual(['ok']);
  });

  it('ignores tags that arrive as an object', async () => {
    vi.mocked(execa).mockResolvedValue(execaSuccess(videoInfoStdout({ tags: { a: 1 } })));

    const { getVideoInfo } = await import('../../src/utils/youtube.js');

    expect((await getVideoInfo('dQw4w9WgXcQ')).tags).toEqual([]);
  });

  it('refetches when the cache file cannot be read at all', async () => {
    const { existsSync } = await import('fs');
    const { readFile } = await import('fs/promises');
    vi.mocked(existsSync).mockImplementation((path) => String(path).endsWith('.json'));
    vi.mocked(readFile).mockRejectedValue(new Error('EIO'));
    vi.mocked(execa).mockResolvedValue(execaSuccess(''));

    const { getTranscript } = await import('../../src/utils/youtube.js');

    // An unreadable cache must behave as no cache, not as a failed request.
    await expect(getTranscript('dQw4w9WgXcQ', { language: 'en' })).rejects.toMatchObject({
      code: 'NO_CAPTIONS',
    });
    expect(execa).toHaveBeenCalled();
  });
});
