import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf } from '../helpers.js';

vi.mock('../../src/utils/youtube.js', () => ({
  getComments: vi.fn(),
}));

describe('get-comments tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return comments as formatted text', async () => {
    const { getComments } = await import('../../src/utils/youtube.js');
    vi.mocked(getComments).mockResolvedValue([
      {
        author: 'YouTube',
        text: 'Great video!',
        likeCount: 232000,
        isPinned: true,
      },
      {
        author: 'User123',
        text: 'Very helpful tutorial',
        likeCount: 500,
        isPinned: false,
      },
    ]);

    const { getCommentsHandler } = await import('../../src/tools/get-comments.js');
    const result = await getCommentsHandler({ video: 'test123', limit: 20 });

    const text = textOf(result);
    expect(text).toContain('2 top comments');
    expect(text).toContain('@YouTube');
    expect(text).toContain('[pinned]');
    expect(text).toContain('232,000 likes');
    expect(text).toContain('@User123');
    expect(text).toContain('Great video!');
  });

  it('should handle videos without comments', async () => {
    const { getComments } = await import('../../src/utils/youtube.js');
    vi.mocked(getComments).mockResolvedValue([]);

    const { getCommentsHandler } = await import('../../src/tools/get-comments.js');
    const result = await getCommentsHandler({ video: 'test123', limit: 20 });

    expect(textOf(result)).toContain('No comments found');
  });
});
