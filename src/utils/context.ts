import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request state that every layer needs but nothing wants in its signature.
 *
 * The alternative is threading `{ signal }` through all 13 handlers and every
 * yt-dlp helper beneath them, which buries the actual arguments in plumbing and
 * is easy to forget at exactly the call site where cancellation matters. An
 * AsyncLocalStorage keeps signatures honest and makes cancellation work inside
 * nested and batched calls for free.
 */
export interface RequestContext {
  /** Aborted when the MCP client cancels the request. Kills in-flight yt-dlp. */
  signal?: AbortSignal;
  /** Emits an MCP progress notification, when the client asked for one. */
  reportProgress?: (progress: number, total?: number, message?: string) => void;
  /** Emits an MCP log message at the given level. */
  log?: (level: 'debug' | 'info' | 'warning' | 'error', message: string) => void;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext {
  return storage.getStore() ?? {};
}

/** Throws if the client has cancelled, so long loops can bail between steps. */
export function throwIfAborted(): void {
  currentContext().signal?.throwIfAborted();
}

export function reportProgress(progress: number, total?: number, message?: string): void {
  currentContext().reportProgress?.(progress, total, message);
}

export function log(level: 'debug' | 'info' | 'warning' | 'error', message: string): void {
  currentContext().log?.(level, message);
}
