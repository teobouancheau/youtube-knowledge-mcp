import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn(), ExecaError: class extends Error {} }));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdtemp: vi.fn((prefix: string) => Promise.resolve(`${prefix}XXXXXX`)),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/utils/preflight.js', () => ({ requireFfmpeg: vi.fn() }));
vi.mock('../../src/utils/validate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/validate.js')>()),
  assertInsideHome: vi.fn((input: string) => input),
  resolveOutputDir: vi.fn((dir: string | undefined, fallback: string) => dir ?? fallback),
}));

import { execa } from 'execa';
import { rm, stat, writeFile } from 'node:fs/promises';
import { requireFfmpeg } from '../../src/utils/preflight.js';
import { assertInsideHome } from '../../src/utils/validate.js';
import { MAX_CONCAT_FILES, concatClips } from '../../src/utils/concat.js';

const A = '/home/u/clips/a.mp4';
const B = '/home/u/clips/b.mp4';

function argv(): string[] {
  const args = vi.mocked(execa).mock.calls[0]?.[1];
  return Array.isArray(args) ? args.map(String) : [];
}

function listWritten(): string {
  const data = vi.mocked(writeFile).mock.calls[0]?.[1];
  return typeof data === 'string' ? data : '';
}

/** The inputs are real files. The result exists only once ffmpeg has run. */
let joined = false;

beforeEach(() => {
  vi.clearAllMocks();
  joined = false;
  vi.mocked(requireFfmpeg).mockResolvedValue(undefined);
  vi.mocked(execa).mockImplementation((() => {
    joined = true;
    return Promise.resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  }) as never);
  vi.mocked(stat).mockImplementation(((path: string) =>
    path.startsWith('/home/u/clips/') || joined
      ? Promise.resolve({ isFile: () => true, size: 4096 })
      : Promise.reject(new Error('ENOENT'))) as never);
});

describe('concatClips', () => {
  it('joins the files in the order given, through the concat demuxer, re-encoded', async () => {
    await concatClips([A, B], {});

    const args = argv();
    expect(args[args.indexOf('-f') + 1]).toBe('concat');
    expect(args[args.indexOf('-safe') + 1]).toBe('0');
    expect(args).toContain('libx264');
    expect(listWritten().split('\n').filter(Boolean)).toEqual([`file '${A}'`, `file '${B}'`]);
  });

  it('lets ffmpeg open only files, since the list is the only thing it reads', async () => {
    await concatClips([A, B], {});

    const args = argv();
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file');
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
  });

  it('escapes a quote in a path so it cannot end the entry and start another', async () => {
    await concatClips([`/home/u/clips/it's.mp4`, B], {});

    expect(listWritten().split('\n')[0]).toBe(`file '/home/u/clips/it'\\''s.mp4'`);
  });

  it('checks every file is inside the home directory', async () => {
    await concatClips([A, B], {});

    expect(assertInsideHome).toHaveBeenCalledWith(A, expect.any(String));
    expect(assertInsideHome).toHaveBeenCalledWith(B, expect.any(String));
  });

  it('keeps its list in a folder of its own, and removes the folder when done or when ffmpeg fails', async () => {
    await concatClips([A, B], {});
    expect(vi.mocked(writeFile).mock.calls[0]?.[0]).toMatch(/\.concat-XXXXXX\/list\.txt$/);
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/\.concat-XXXXXX$/), {
      recursive: true,
      force: true,
    });

    vi.mocked(rm).mockClear();
    vi.mocked(execa).mockRejectedValue(new Error('boom'));
    await expect(concatClips([A, B], {})).rejects.toMatchObject({ code: 'YTDLP_FAILED' });
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/\.concat-XXXXXX$/), {
      recursive: true,
      force: true,
    });
  });

  it('refuses a result that would overwrite one of the clips being joined', async () => {
    await expect(
      concatClips([A, B], { name: 'a', outputDir: '/home/u/clips' })
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('a clip being joined'),
    });
    expect(execa).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a file it did not make when the caller chose the name', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, size: 1 } as never);

    await expect(concatClips([A, B], { name: 'taken' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('already exists'),
    });
    expect(execa).not.toHaveBeenCalled();
  });

  it('rewrites its own derived name when the same clips are joined again', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, size: 1 } as never);

    await expect(concatClips([A, B], {})).resolves.toMatchObject({ clips: 2 });
  });

  it('names the result as asked, or the same way every time for the same files', async () => {
    const named = await concatClips([A, B], { name: 'my montage' });
    expect(named.filePath).toMatch(/my montage\.mp4$/);

    const first = await concatClips([A, B], {});
    const second = await concatClips([A, B], {});
    const other = await concatClips([B, A], {});
    expect(first.filePath).toMatch(/montage-[0-9a-f]{8}\.mp4$/);
    expect(second.filePath).toBe(first.filePath);
    expect(other.filePath).not.toBe(first.filePath);
  });

  it('reports how many clips went in and how big the result is', async () => {
    expect(await concatClips([A, B], {})).toMatchObject({ clips: 2, bytes: 4096 });
  });

  it('needs at least two clips, and no more than the cap', async () => {
    await expect(concatClips([A], {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      concatClips(
        Array.from({ length: MAX_CONCAT_FILES + 1 }, () => A),
        {}
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(execa).not.toHaveBeenCalled();
  });

  it('names the file that is not a file, before any ffmpeg work', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => false, size: 0 } as never);

    await expect(concatClips([A, B], {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining(A),
    });
    expect(execa).not.toHaveBeenCalled();
  });

  it('names the file that does not exist', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

    await expect(concatClips([A, B], {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining(A),
    });
  });

  it('checks ffmpeg first', async () => {
    vi.mocked(requireFfmpeg).mockRejectedValue(new Error('no ffmpeg'));

    await expect(concatClips([A, B], {})).rejects.toThrow('no ffmpeg');
    expect(stat).not.toHaveBeenCalled();
  });
});
