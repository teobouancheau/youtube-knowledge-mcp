import { YouTubeError } from './errors.js';
import type { Chapter } from './youtube.js';

/**
 * Resolving a chapter name a caller typed to a chapter the video actually has.
 *
 * Exact title first, then a substring, both case-insensitive: people remember
 * "the middle" of a talk, not "03 — The Middle Section (part 2)". Two tools
 * used to carry identical copies of this; a mismatch in how they matched
 * would have meant a chapter that clips but cannot be read, or the reverse.
 */
export function resolveChapter(chapters: Chapter[], name: string, whenNone: string): Chapter {
  if (chapters.length === 0) {
    throw new YouTubeError('NOT_FOUND', 'This video has no chapters.', { nextStep: whenNone });
  }

  const wanted = name.toLowerCase();
  const match =
    chapters.find((chapter) => chapter.title.toLowerCase() === wanted) ??
    chapters.find((chapter) => chapter.title.toLowerCase().includes(wanted));

  if (!match) {
    throw new YouTubeError('NOT_FOUND', `No chapter matches "${name}".`, {
      nextStep: `Available chapters: ${chapters.map((chapter) => chapter.title).join(', ')}`,
    });
  }

  return match;
}
