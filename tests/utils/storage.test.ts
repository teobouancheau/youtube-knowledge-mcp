import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises
// Documents are written through a temporary file handle, flushed and renamed
// into place, so an interrupted write cannot truncate the previous one. The
// handle's write is routed to the same `writeFile` mock so assertions can
// still ask "was something written".
vi.mock('fs/promises', () => {
  const writeFile = vi.fn((_path: string, _data: unknown): Promise<void> => Promise.resolve());
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    writeFile,
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    open: vi.fn(() =>
      Promise.resolve({
        writeFile: (data: unknown) => writeFile('handle', data),
        sync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      })
    ),
  };
});

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

describe('Storage Utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveToLibrary', () => {
    it('should save content to library', async () => {
      const { existsSync } = await import('fs');
      const { writeFile, mkdir, readFile } = await import('fs/promises');

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(readFile).mockRejectedValue(new Error('File not found'));

      const { saveToLibrary } = await import('../../src/utils/storage.js');

      const result = await saveToLibrary({
        videoId: 'testvid0001',
        title: 'Test Video',
        content: '# Summary\n\nThis is a test.',
        contentType: 'summary',
        tags: ['test', 'demo'],
      });

      expect(result.saved).toBe(true);
      expect(result.path).toContain('testvid0001');
      expect(mkdir).toHaveBeenCalled();
      expect(writeFile).toHaveBeenCalled();
    });
  });

  describe('listLibrary', () => {
    it('should return empty list when index does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { listLibrary } = await import('../../src/utils/storage.js');
      const result = await listLibrary();

      expect(result).toEqual([]);
    });

    it('should filter by tag', async () => {
      const { existsSync } = await import('fs');
      const { readFile } = await import('fs/promises');

      const mockIndex = {
        version: 1,
        items: {
          vid1: {
            videoId: 'vid00000001',
            title: 'Video 1',
            tags: ['programming', 'typescript'],
            dateSaved: '2024-01-01',
            channel: 'Test',
            url: 'https://youtube.com/watch?v=vid1',
            hasSummary: true,
            hasSkill: false,
            hasTranscript: false,
          },
          vid2: {
            videoId: 'vid00000002',
            title: 'Video 2',
            tags: ['cooking'],
            dateSaved: '2024-01-02',
            channel: 'Test',
            url: 'https://youtube.com/watch?v=vid2',
            hasSummary: true,
            hasSkill: false,
            hasTranscript: false,
          },
        },
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockIndex));

      const { listLibrary } = await import('../../src/utils/storage.js');
      const result = await listLibrary({ tag: 'programming' });

      expect(result).toHaveLength(1);
      expect(result[0]?.videoId).toBe('vid00000001');
    });
  });
});
