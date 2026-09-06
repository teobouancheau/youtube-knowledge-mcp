import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/ytdlp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/ytdlp.js')>();
  return { ...actual, runYtDlp: vi.fn() };
});

import { runYtDlp } from '../../src/utils/ytdlp.js';
import { playlistTotal } from '../../src/utils/youtube-channel.js';
import { YouTubeError } from '../../src/utils/errors.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('playlistTotal', () => {
  it('reports the count when YouTube states one', async () => {
    vi.mocked(runYtDlp).mockResolvedValue(JSON.stringify({ playlist_count: 1_716 }));
    expect(await playlistTotal('https://youtube.com/@x')).toBe(1_716);
  });

  it('returns undefined when the listing states no count', async () => {
    // Channel tabs routinely omit it. Undefined means unknown, and the caller
    // must not turn that into zero.
    vi.mocked(runYtDlp).mockResolvedValue(JSON.stringify({ playlist_count: null }));
    expect(await playlistTotal('https://youtube.com/@x')).toBeUndefined();
  });

  it('returns undefined rather than failing the page when the probe errors', async () => {
    vi.mocked(runYtDlp).mockRejectedValue(new YouTubeError('RATE_LIMITED', 'throttled'));
    expect(await playlistTotal('https://youtube.com/@x')).toBeUndefined();
  });
});
