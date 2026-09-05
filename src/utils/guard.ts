import { z } from 'zod';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { runWithRequestContext, type RequestContext } from './context.js';
import { asYouTubeError, toToolError } from './errors.js';

/**
 * Wrapping every handler the server registers, once, so that each call gets a
 * request context and no call can throw out of the server.
 *
 * The MCP request's AbortSignal is published to the request context so an
 * in-flight yt-dlp is killed when the client cancels, and anything thrown is
 * rendered as an actionable message rather than a raw stack trace, a yt-dlp
 * command line, or a local path. Tools report failures inside the result with
 * `isError`; resources have no such envelope, so theirs become protocol errors
 * carrying the same normalised text.
 */

/**
 * The parts of the SDK's `RequestHandlerExtra` this server uses.
 *
 * `sendNotification` is described with `z.custom` because a function is not
 * something Zod can take apart structurally — the predicate is a real runtime
 * check, and it is what lets the property be called without asserting a type
 * over it.
 */
const requestExtraSchema = z.object({
  signal: z.instanceof(AbortSignal).optional(),
  sendNotification: z
    .custom<(notification: unknown) => Promise<void>>((value) => typeof value === 'function')
    .optional(),
  _meta: z.object({ progressToken: z.union([z.string(), z.number()]).optional() }).optional(),
});

/** The request context for a call, read from the SDK extra that arrives last. */
function contextOf(args: unknown[]): RequestContext {
  // Handlers declare only their own parameters; the SDK appends
  // RequestHandlerExtra to every call, so it is whatever arrived last.
  const parsed = requestExtraSchema.safeParse(args[args.length - 1]);
  const extra = parsed.success ? parsed.data : undefined;

  return {
    signal: extra?.signal,
    // Progress is only meaningful when the client asked for it by sending a
    // token; without one the notification would be dropped anyway.
    reportProgress:
      extra?.sendNotification && extra._meta?.progressToken !== undefined
        ? (progress, total, message) => {
            void extra.sendNotification?.({
              method: 'notifications/progress',
              params: {
                progressToken: extra._meta?.progressToken,
                progress,
                ...(total === undefined ? {} : { total }),
                ...(message === undefined ? {} : { message }),
              },
            });
          }
        : undefined,
    log: extra?.sendNotification
      ? (level, message) => {
          void extra.sendNotification?.({
            method: 'notifications/message',
            params: { level, logger: 'youtube-knowledge-mcp', data: message },
          });
        }
      : undefined,
  };
}

export function guarded<A extends unknown[]>(
  handler: (...args: A) => Promise<CallToolResult>
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A): Promise<CallToolResult> =>
    runWithRequestContext(contextOf(args), async () => {
      try {
        return await handler(...args);
      } catch (error) {
        return toToolError(error);
      }
    });
}

/**
 * The resource counterpart. A read that fails used to propagate whatever was
 * thrown — an `ENOENT` carrying an absolute local path, for instance — as the
 * JSON-RPC error message. It now carries the same `[CODE] message` a tool
 * would show, and nothing else.
 */
export function guardedResource<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> =>
    runWithRequestContext(contextOf(args), async () => {
      try {
        return await handler(...args);
      } catch (error) {
        const failure = asYouTubeError(error);
        const code =
          failure.code === 'INVALID_INPUT' || failure.code === 'NOT_FOUND'
            ? ErrorCode.InvalidParams
            : ErrorCode.InternalError;
        throw new McpError(code, `[${failure.code}] ${failure.toToolMessage()}`);
      }
    });
}
