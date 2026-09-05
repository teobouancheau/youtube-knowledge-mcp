import { describe, it, expect, vi } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { guarded, guardedResource } from '../../src/utils/guard.js';
import { currentContext, log, reportProgress } from '../../src/utils/context.js';
import { YouTubeError } from '../../src/utils/errors.js';

/**
 * The SDK appends a RequestHandlerExtra to every handler call. These tests
 * hand-build one, so the wiring from that object to the request context can be
 * asserted without a transport in the way.
 */
function extra(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signal: new AbortController().signal,
    sendNotification: vi.fn().mockResolvedValue(undefined),
    _meta: { progressToken: 7 },
    ...overrides,
  };
}

describe('guarded', () => {
  it('publishes the abort signal to the request context', async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const handler = guarded((_extra: unknown) => {
      seen.push(currentContext().signal);
      return Promise.resolve({ content: [] });
    });

    await handler(extra({ signal: controller.signal }));

    expect(seen[0]).toBe(controller.signal);
  });

  it('forwards progress with and without a total and message', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const handler = guarded((_extra: unknown) => {
      reportProgress(1);
      reportProgress(2, 10, 'halfway');
      return Promise.resolve({ content: [] });
    });

    await handler(extra({ sendNotification: send }));

    expect(send).toHaveBeenNthCalledWith(1, {
      method: 'notifications/progress',
      params: { progressToken: 7, progress: 1 },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      method: 'notifications/progress',
      params: { progressToken: 7, progress: 2, total: 10, message: 'halfway' },
    });
  });

  it('forwards log messages to the client', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const handler = guarded((_extra: unknown) => {
      log('warning', 'slow');
      return Promise.resolve({ content: [] });
    });

    await handler(extra({ sendNotification: send }));

    expect(send).toHaveBeenCalledWith({
      method: 'notifications/message',
      params: { level: 'warning', logger: 'youtube-knowledge-mcp', data: 'slow' },
    });
  });

  it('drops progress when the client sent no token, and log when it cannot receive one', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const withoutToken = guarded((_extra: unknown) => {
      reportProgress(1);
      return Promise.resolve({ content: [] });
    });
    await withoutToken(extra({ sendNotification: send, _meta: {} }));
    expect(send).not.toHaveBeenCalled();

    const seen: unknown[] = [];
    const withoutChannel = guarded((_extra: unknown) => {
      seen.push(currentContext().log, currentContext().reportProgress);
      return Promise.resolve({ content: [] });
    });
    await withoutChannel(extra({ sendNotification: undefined }));
    expect(seen).toEqual([undefined, undefined]);
  });

  it('tolerates a last argument that is not a request extra at all', async () => {
    const handler = guarded((_extra: unknown) => Promise.resolve({ content: [] }));

    await expect(handler('just an argument')).resolves.toEqual({ content: [] });
  });

  it('renders a thrown error as an isError result', async () => {
    const handler = guarded((_extra: unknown) => {
      return Promise.reject(new YouTubeError('NOT_FOUND', 'gone', { nextStep: 'look elsewhere' }));
    });

    const result = await handler(extra());

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: '[NOT_FOUND] gone\n\nlook elsewhere' });
  });
});

describe('guardedResource', () => {
  it('passes a successful read through', async () => {
    const read = guardedResource((value: number, _extra: unknown) =>
      Promise.resolve({ doubled: value * 2 })
    );

    await expect(read(21, extra())).resolves.toEqual({ doubled: 42 });
  });

  it.each([
    ['INVALID_INPUT', -32602],
    ['NOT_FOUND', -32602],
    ['YTDLP_FAILED', -32603],
    ['RATE_LIMITED', -32603],
  ] as const)('maps %s to JSON-RPC code %d, keeping the typed message', async (code, rpc) => {
    const read = guardedResource((_extra: unknown) => {
      return Promise.reject(new YouTubeError(code, 'why', { nextStep: 'how' }));
    });

    const error = await read(extra()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(rpc);
    expect((error as McpError).message).toContain(`[${code}] why`);
    expect((error as McpError).message).toContain('how');
  });

  it('never forwards the text of an unexpected error', async () => {
    const read = guardedResource((_extra: unknown) => {
      return Promise.reject(new Error('ENOENT: open /Users/someone/secret.md'));
    });

    const error = await read(extra()).catch((e: unknown) => e);

    expect((error as McpError).message).toContain('[YTDLP_FAILED]');
    expect((error as McpError).message).not.toContain('/Users');
  });
});
