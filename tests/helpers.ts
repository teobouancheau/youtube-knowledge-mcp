import { expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Narrow a tool result to its first text block.
 *
 * `CallToolResult['content']` is a union (text | image | audio | resource_link |
 * embedded resource), so `result.content[0].text` does not typecheck. Every tool
 * in this server returns text first; this asserts that and hands back the string.
 */
/**
 * The tool's structured output.
 *
 * Every tool declares an `outputSchema` and so must return `structuredContent`;
 * asserting its presence here means a tool that quietly stopped returning it
 * fails the test that reads it rather than silently comparing `undefined`.
 */
export function structuredOf(result: CallToolResult): Record<string, unknown> {
  const { structuredContent } = result;
  expect(structuredContent, 'expected structuredContent on the result').toBeDefined();
  if (structuredContent === undefined) throw new Error('missing structuredContent');
  return structuredContent;
}

export function textOf(result: CallToolResult, index = 0): string {
  const block = result.content[index];
  expect(block, `expected a content block at index ${index}`).toBeDefined();
  if (block?.type !== 'text') {
    throw new Error(`content[${index}] is "${block?.type ?? 'missing'}", expected "text"`);
  }
  return block.text;
}
