/**
 * Fixed-window counter, per client.
 *
 * The map is capped as well as swept. A client that can vary its key at will
 * — which is what an unvalidated forwarding header allowed — could otherwise
 * grow it without limit inside a single window.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000
  ) {}

  check(
    key: string,
    now = Date.now()
  ): { allowed: boolean; remaining: number; retryAfter: number } {
    const entry = this.hits.get(key);

    if (!entry || now > entry.resetAt) {
      if (!entry) this.makeRoom(now);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfter: 0 };
    }

    entry.count++;
    const allowed = entry.count <= this.limit;
    return {
      allowed,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfter: allowed ? 0 : Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  /** Expired entries go first; failing that, the oldest live one (Map insertion order). */
  private makeRoom(now: number): void {
    if (this.hits.size < this.maxKeys) return;
    this.sweep(now);
    if (this.hits.size < this.maxKeys) return;
    const oldest = this.hits.keys().next();
    if (!oldest.done) this.hits.delete(oldest.value);
  }

  sweep(now = Date.now()): void {
    for (const [key, entry] of this.hits) {
      if (now > entry.resetAt) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
