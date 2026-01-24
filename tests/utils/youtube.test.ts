import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execa before importing the module
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

describe('YouTube Utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getVideoInfo', () => {
    it('should extract video info from yt-dlp output', async () => {
      const { execa } = await import('execa');
      const mockedExeca = vi.mocked(execa);

      mockedExeca.mockResolvedValue({
        stdout:
          'dQw4w9WgXcQ|||Never Gonna Give You Up|||Rick Astley|||213|||20091025|||Description|||["tag1","tag2"]|||https://thumbnail.jpg',
        stderr: '',
        exitCode: 0,
        failed: false,
        command: '',
        escapedCommand: '',
        killed: false,
        timedOut: false,
      } as never);

      const { getVideoInfo } = await import('../../src/utils/youtube.js');
      const result = await getVideoInfo('dQw4w9WgXcQ');

      expect(result).toMatchObject({
        id: 'dQw4w9WgXcQ',
        title: 'Never Gonna Give You Up',
        channel: 'Rick Astley',
        duration: 213,
      });
    });

    it('should handle YouTube URLs', async () => {
      const { execa } = await import('execa');
      const mockedExeca = vi.mocked(execa);

      mockedExeca.mockResolvedValue({
        stdout: 'ABC123xyzAB|||Test|||Channel|||60|||20240101|||Desc|||[]|||thumb.jpg',
        stderr: '',
        exitCode: 0,
        failed: false,
        command: '',
        escapedCommand: '',
        killed: false,
        timedOut: false,
      } as never);

      const { getVideoInfo } = await import('../../src/utils/youtube.js');
      const result = await getVideoInfo('https://www.youtube.com/watch?v=ABC123xyzAB');

      expect(mockedExeca).toHaveBeenCalledWith(
        'yt-dlp',
        expect.arrayContaining(['https://www.youtube.com/watch?v=ABC123xyzAB'])
      );
      expect(result.id).toBe('ABC123xyzAB');
    });
  });

  describe('listVideos', () => {
    it('should list videos from a playlist', async () => {
      const { execa } = await import('execa');
      const mockedExeca = vi.mocked(execa);

      mockedExeca.mockResolvedValue({
        stdout: 'vid1|||Title 1|||120|||20240101\nvid2|||Title 2|||180|||20240102',
        stderr: '',
        exitCode: 0,
        failed: false,
        command: '',
        escapedCommand: '',
        killed: false,
        timedOut: false,
      } as never);

      const { listVideos } = await import('../../src/utils/youtube.js');
      const result = await listVideos('https://youtube.com/playlist?list=PLtest', 10);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'vid1',
        title: 'Title 1',
        duration: 120,
      });
    });
  });
});
