import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function formatCount(count: number): string {
  if (count >= 1_000_000_000) return `${trimTrailingZero(count / 1_000_000_000)}B`;
  if (count >= 1_000_000) return `${trimTrailingZero(count / 1_000_000)}M`;
  if (count >= 1_000) return `${trimTrailingZero(count / 1_000)}K`;
  return count.toString();
}

function trimTrailingZero(n: number): string {
  const fixed = n.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

export function formatYouTubeDate(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length < 8) return '';
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export function formatFilesize(bytes?: number): string {
  if (!bytes) return 'Unknown';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * A tool result carrying both a human-readable rendering and machine-readable
 * data.
 *
 * The text block is what a client displays; `structuredContent` is additive and
 * is what the tool's `outputSchema` describes. Every tool that declares an
 * output schema must return this, because the SDK validates the two against
 * each other.
 */
export function toolResult(text: string, structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: structured,
  };
}

/** Standard pagination envelope, reported by every list-shaped tool. */
export interface PageInfo {
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
}

/**
 * Takes an object, not three adjacent numbers.
 *
 * The bug this replaces was not in the arithmetic: it was five call sites that
 * passed `count` where `total` belonged, so `hasMore` computed `n < n` and a
 * caller with 20 of a channel's 5,000 videos was told it had all of them.
 * Positional arguments of the same type made that invisible; an object makes
 * it impossible, and changing the signature forced every call site to be
 * revisited, which was the point.
 */
export interface PageInput {
  /** Items available in total. Never `count` — that is the bug this shape prevents. */
  total: number;
  count: number;
  offset?: number;
}

export function pageInfo({ total, count, offset = 0 }: PageInput): PageInfo {
  const hasMore = offset + count < total;
  return {
    total,
    count,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset: offset + count } : {}),
  };
}

/** A link to a file this server produced, so clients can offer to open it. */
export function fileResourceLink(
  filePath: string,
  name: string,
  mimeType?: string
): { type: 'resource_link'; uri: string; name: string; mimeType?: string } {
  return {
    type: 'resource_link',
    uri: `file://${filePath}`,
    name,
    ...(mimeType === undefined ? {} : { mimeType }),
  };
}

/** A result that both reads well and points at the file it produced. */
export function fileResult(
  text: string,
  structured: Record<string, unknown>,
  file: { path: string; name: string; mimeType?: string }
): CallToolResult {
  return {
    content: [
      { type: 'text' as const, text },
      fileResourceLink(file.path, file.name, file.mimeType),
    ],
    structuredContent: structured,
  };
}
