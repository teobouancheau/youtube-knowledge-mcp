import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** Live MCP sessions, keyed by the id the transport issued. */

export interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  set(id: string, transport: StreamableHTTPServerTransport): void {
    this.sessions.set(id, { transport, lastSeen: Date.now() });
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /** Closes and forgets every session idle longer than `idleMs`. */
  sweep(now: number, idleMs: number): void {
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen > idleMs) {
        this.sessions.delete(id);
        void session.transport.close();
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const [id, session] of this.sessions) {
      this.sessions.delete(id);
      await session.transport.close();
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}
