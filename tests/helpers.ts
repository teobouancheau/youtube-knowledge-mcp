import { expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Narrow a tool result to its first text block.
 *
 * `CallToolResult['content']` is a union (text | image | audio | resource_link |
 * embedded resource), so `result.content[0].text` does not typecheck. Every tool
 * in this server returns text first; this asserts that and hands back the string.
 */
export function textOf(result: CallToolResult, index = 0): string {
  const block = result.content[index];
  expect(block, `expected a content block at index ${index}`).toBeDefined();
  expect(block.type).toBe('text');
  if (block.type !== 'text') {
    throw new Error(`content[${index}] is "${block.type}", expected "text"`);
  }
  return block.text;
}
