import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/youtube.js', () => ({
  getChapters: vi.fn(),
}));

describe('get-chapters tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return chapters as formatted text', async () => {
    const { getChapters } = await import('../../src/utils/youtube.js');
    vi.mocked(getChapters).mockResolvedValue([
      {
        title: 'Introduction',
        startTime: 0,
        startTimeFormatted: '0:00',
        endTime: 120,
        endTimeFormatted: '2:00',
      },
      {
        title: 'Main Content',
        startTime: 120,
        startTimeFormatted: '2:00',
        endTime: 600,
        endTimeFormatted: '10:00',
      },
    ]);

    const { getChaptersHandler } = await import('../../src/tools/get-chapters.js');
    const result = await getChaptersHandler({ video: 'test123' });

    const text = result.content[0].text;
    expect(text).toContain('2 chapters');
    expect(text).toContain('[0:00 - 2:00] Introduction');
    expect(text).toContain('[2:00 - 10:00] Main Content');
  });

  it('should handle videos without chapters', async () => {
    const { getChapters } = await import('../../src/utils/youtube.js');
    vi.mocked(getChapters).mockResolvedValue([]);

    const { getChaptersHandler } = await import('../../src/tools/get-chapters.js');
    const result = await getChaptersHandler({ video: 'test123' });

    expect(result.content[0].text).toContain('No chapters found');
  });
});
