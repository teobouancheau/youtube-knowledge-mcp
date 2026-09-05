import { YouTubeError } from './errors.js';

/**
 * Compiling a caller-supplied search pattern without handing the event loop
 * to it.
 *
 * JavaScript's regex engine backtracks, and a pattern such as `(a+)+$` takes
 * time exponential in the input on a non-matching string. `search_transcript`
 * runs the caller's pattern over every caption window of a video, on a server
 * whose HTTP transport is shared, so an unbounded pattern is a way to stall
 * every session at once. The rule below is conservative — it refuses some
 * harmless patterns — but it is simple enough to explain in an error message
 * and needs no second regex engine.
 */

export const MAX_PATTERN_LENGTH = 200;

interface Group {
  quantified: boolean;
  alternation: boolean;
}

const QUANTIFIER_START = new Set(['*', '+', '?', '{']);

function unsafe(reason: string): YouTubeError {
  return new YouTubeError(
    'INVALID_INPUT',
    `This pattern could run for a very long time: ${reason}.`,
    {
      nextStep:
        'A repeated group may not itself contain repetition or alternation, and backreferences are not supported. Simplify the pattern, or set regex=false to search literally.',
    }
  );
}

/** True when `source[at]` begins a quantifier: `*`, `+`, `?` or a `{n}`, `{n,}`, `{n,m}` bound. */
function quantifierAt(source: string, at: number): boolean {
  const char = source[at];
  if (char === undefined || !QUANTIFIER_START.has(char)) return false;
  if (char !== '{') return true;
  return /^\{\d+(?:,\d*)?\}/.test(source.slice(at));
}

/** Index just past the character class that opens at `at`. */
function skipClass(source: string, at: number): number {
  let index = at + 1;
  while (index < source.length && source[index] !== ']') {
    if (source[index] === '\\') index++;
    index++;
  }
  return index + 1;
}

/**
 * Index just past a group opener: `(`, or `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`
 * and `(?<name>`, whose `?` is syntax rather than a quantifier.
 */
function skipGroupOpener(source: string, at: number): number {
  if (source[at + 1] !== '?') return at + 1;
  const modifier = source[at + 2];
  if (modifier === '<') {
    const lookbehind = source[at + 3];
    if (lookbehind === '=' || lookbehind === '!') return at + 4;
    const close = source.indexOf('>', at + 3);
    return close === -1 ? at + 3 : close + 1;
  }
  return at + 3;
}

/**
 * Throws when a repeated group contains repetition or alternation, or when the
 * pattern uses a backreference.
 */
export function assertSafePattern(source: string): void {
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new YouTubeError(
      'INVALID_INPUT',
      `Patterns are limited to ${MAX_PATTERN_LENGTH} characters.`,
      {
        nextStep: 'Search for a shorter phrase, or set regex=false to search literally.',
      }
    );
  }

  const root: Group = { quantified: false, alternation: false };
  const stack: Group[] = [root];
  const current = (): Group => stack[stack.length - 1] ?? root;

  let index = 0;
  while (index < source.length) {
    const char = source[index];

    if (char === '\\') {
      const next = source[index + 1];
      if ((next !== undefined && /[1-9]/.test(next)) || next === 'k') {
        throw unsafe('backreferences are not supported');
      }
      index += 2;
      continue;
    }

    if (char === '[') {
      index = skipClass(source, index);
      continue;
    }

    if (char === '(') {
      stack.push({ quantified: false, alternation: false });
      index = skipGroupOpener(source, index);
      continue;
    }

    if (char === ')') {
      const closed = stack.pop() ?? root;
      index++;
      if (quantifierAt(source, index)) {
        if (closed.quantified || closed.alternation) {
          throw unsafe('a repeated group contains repetition or alternation');
        }
        current().quantified = true;
      }
      continue;
    }

    if (char === '|') current().alternation = true;
    if (quantifierAt(source, index)) current().quantified = true;
    index++;
  }
}

export interface PatternOptions {
  regex: boolean;
  caseSensitive: boolean;
}

/**
 * Compile the caller's query once, with the flags the search will use.
 *
 * A literal query is escaped so that `a.` matches "a." and nothing else; a
 * regex query is checked for the backtracking rule and for syntax.
 */
export function compilePattern(query: string, options: PatternOptions): RegExp {
  const flags = options.caseSensitive ? 'g' : 'gi';

  if (!options.regex) {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }

  assertSafePattern(query);
  try {
    return new RegExp(query, flags);
  } catch (error) {
    throw new YouTubeError('INVALID_INPUT', `"${query}" is not a valid regular expression.`, {
      nextStep: 'Fix the pattern, or set regex=false to search for it literally.',
      cause: error,
    });
  }
}
