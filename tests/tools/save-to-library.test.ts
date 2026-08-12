import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textOf, structuredOf } from '../helpers.js';

vi.mock('../../src/utils/storage.js', () => ({ saveToLibrary: vi.fn() }));

import { saveToLibrary } from '../../src/utils/storage.js';
import { saveToLibraryHandler } from '../../src/tools/save-to-library.js';

const ARGS = {
  videoId: 'dQw4w9WgXcQ',
  title: 'A Talk About Systems',
  content: '# Notes',
  contentType: 'summary' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveToLibrary).mockResolvedValue({
    path: '/home/u/.youtube-knowledge/library/dQw4w9WgXcQ/summary.md',
    saved: true,
  });
});

describe('saveToLibraryHandler', () => {
  it('saves the note and reports where it went', async () => {
    const result = await saveToLibraryHandler(ARGS);

    expect(textOf(result)).toContain('Saved summary to library');
    expect(structuredOf(result)).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      title: 'A Talk About Systems',
      contentType: 'summary',
      filePath: '/home/u/.youtube-knowledge/library/dQw4w9WgXcQ/summary.md',
      tags: [],
    });
  });

  it('forwards every field to storage', async () => {
    await saveToLibraryHandler({ ...ARGS, channel: 'Some Channel', tags: ['systems'] });

    expect(saveToLibrary).toHaveBeenCalledWith({
      videoId: 'dQw4w9WgXcQ',
      title: 'A Talk About Systems',
      content: '# Notes',
      contentType: 'summary',
      channel: 'Some Channel',
      tags: ['systems'],
    });
  });

  it('mentions the channel only when there is one', async () => {
    expect(textOf(await saveToLibraryHandler({ ...ARGS, channel: 'Some Channel' }))).toContain(
      'by Some Channel'
    );
    expect(textOf(await saveToLibraryHandler(ARGS))).not.toContain('by ');
  });

  it('lists tags when given, and says nothing about them otherwise', async () => {
    expect(textOf(await saveToLibraryHandler({ ...ARGS, tags: ['a', 'b'] }))).toContain(
      'tags: a, b'
    );
    expect(textOf(await saveToLibraryHandler({ ...ARGS, tags: [] }))).not.toContain('tags:');
  });

  it('reports the tags it saved in structured output', async () => {
    expect(structuredOf(await saveToLibraryHandler({ ...ARGS, tags: ['x'] }))).toMatchObject({
      tags: ['x'],
    });
  });

  it('attaches the saved file as a markdown resource link', async () => {
    const result = await saveToLibraryHandler(ARGS);
    const link = result.content.find((block) => block.type === 'resource_link');

    expect(link).toMatchObject({ mimeType: 'text/markdown' });
  });

  it('labels a skill note as such', async () => {
    vi.mocked(saveToLibrary).mockResolvedValue({ path: '/lib/skill.md', saved: true });

    const result = await saveToLibraryHandler({ ...ARGS, contentType: 'skill' });

    expect(textOf(result)).toContain('Saved skill to library');
    expect(structuredOf(result)).toMatchObject({ contentType: 'skill' });
  });
});
