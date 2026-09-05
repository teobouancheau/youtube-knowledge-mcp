import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** Live MCP sessions, keyed by the id the transport issued. */

export interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

/**
 * Capacity is reserved synchronously, before the awaits that create a session.
 *
 * Checking `size` and then awaiting let every concurrent initialize pass the
 * check together and overshoot the cap. A reservation counts from the moment
 * the decision is made until the session is committed or abandoned.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private reserved = 0;

  constructor(private readonly maxSessions: number) {}

  /** Claims a slot, or reports that none is free. Pending reservations count. */
  reserve(): boolean {
    if (this.sessions.size + this.reserved >= this.maxSessions) return false;
    this.reserved++;
    return true;
  }

  /** Turns a reservation into a session. */
  commit(id: string, transport: StreamableHTTPServerTransport): void {
    this.reserved = Math.max(0, this.reserved - 1);
    this.sessions.set(id, { transport, lastSeen: Date.now() });
  }

  /** Gives a reservation back when the session never came to be. */
  release(): void {
    this.reserved = Math.max(0, this.reserved - 1);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastSeen = Date.now();
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

  /** Committed sessions only; reservations are transient. */
  get size(): number {
    return this.sessions.size;
  }
}
