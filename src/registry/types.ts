import type { ZodRawShape } from 'zod';
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { guarded } from '../utils/guard.js';

/**
 * A tool as one declarative record.
 *
 * `createServer` used to be twenty-seven near-identical `registerTool` calls
 * spread over seven hundred lines, and the only thing that varied between them
 * was data. Declaring each tool as data keeps the registration in one loop,
 * lets a test enumerate every tool without booting a server, and makes the
 * transport gate — local-only tools never registered over HTTP — a field
 * rather than an `if` block a new tool can land on the wrong side of.
 */

export type ToolMode = 'all' | 'stdio';

export interface ToolDefinition {
  name: string;
  mode: ToolMode;
  register: (server: McpServer) => void;
}

export interface ToolSpec<In extends ZodRawShape, Out extends ZodRawShape> {
  name: string;
  mode: ToolMode;
  title: string;
  description: string;
  inputSchema: In;
  outputSchema: Out;
  /** Every hint is required: a client decides what to ask before running on them. */
  annotations: Required<
    Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>
  >;
  handler: ToolCallback<In>;
}

/**
 * Capture the schema/handler pairing generically, then hand back a record the
 * registry can hold in one array without any of them needing a cast.
 */
export function defineTool<In extends ZodRawShape, Out extends ZodRawShape>(
  spec: ToolSpec<In, Out>
): ToolDefinition {
  const { name, mode, title, description, inputSchema, outputSchema, annotations, handler } = spec;
  return {
    name,
    mode,
    register: (server) => {
      server.registerTool(
        name,
        { title, description, inputSchema, outputSchema, annotations },
        guarded(handler)
      );
    },
  };
}
