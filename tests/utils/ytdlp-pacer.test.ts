import { describe, it, expect, beforeEach } from 'vitest';
import {
  AIMD_INCREASE_AFTER_SUCCESSES,
  AIMD_MIN_CONCURRENCY,
  BOT_CHECK_COOLDOWN_MS,
  CIRCUIT_OPEN_MS,
  CIRCUIT_STRIKES,
  MAX_BACKOFF_MS,
  RATE_LIMIT_COOLDOWN_MAX_MS,
  backoffDelay,
  circuitOpen,
  effectiveConcurrency,
  onFailure,
  onSuccess,
  pacerState,
  policyFor,
  resetPacer,
  waitMs,
} from '../../src/utils/ytdlp-pacer.js';

const NOW = 1_000_000;

beforeEach(() => {
  resetPacer();
});

describe('retry policy', () => {
  it('does not retry a bot check, because retrying was measured not to help', () => {
    // Eight player clients, a 15-minute cooldown, a PO token provider and TLS
    // impersonation all returned the same answer from a gated address.
    expect(policyFor('BOT_CHECK').attempts).toBe(1);
    expect(policyFor('BOT_CHECK').concurrency).toBe('floor');
  });

  it('retries a rate limit hardest, since that one does clear', () => {
    expect(policyFor('RATE_LIMITED').attempts).toBe(5);
    expect(policyFor('RATE_LIMITED').backoff).toBe('exponential');
  });

  it('treats an unlisted code as terminal rather than retrying blindly', () => {
    expect(policyFor('PRIVATE').attempts).toBe(1);
    expect(policyFor('NOT_FOUND').attempts).toBe(1);
  });
});

describe('backoff', () => {
  it('never exceeds the ceiling, however many attempts have passed', () => {
    for (let attempt = 1; attempt < 40; attempt += 1) {
      expect(backoffDelay(attempt, 'exponential')).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
  });

  it('is zero when the policy says not to wait', () => {
    expect(backoffDelay(3, 'none')).toBe(0);
  });
});

describe('cooldown', () => {
  it('gives a single throttle a grace, so one blip costs nothing', () => {
    onFailure('RATE_LIMITED', 1, NOW);
    expect(waitMs(NOW)).toBe(0);
  });

  it('starts once the client has been refused twice in a row', () => {
    onFailure('RATE_LIMITED', 1, NOW);
    onFailure('RATE_LIMITED', 2, NOW);
    expect(waitMs(NOW)).toBeGreaterThan(0);
  });

  it('skips the grace for a bot check, which does not clear on its own', () => {
    onFailure('BOT_CHECK', 1, NOW);
    expect(waitMs(NOW)).toBeGreaterThan(BOT_CHECK_COOLDOWN_MS * 0.5);
  });

  it('escalates but stays under the ceiling', () => {
    for (let strike = 1; strike <= 12; strike += 1) onFailure('RATE_LIMITED', 1, NOW);
    expect(waitMs(NOW)).toBeLessThanOrEqual(RATE_LIMIT_COOLDOWN_MAX_MS * 1.25);
  });

  it('expires on its own', () => {
    onFailure('RATE_LIMITED', 1, NOW);
    onFailure('RATE_LIMITED', 2, NOW);
    expect(waitMs(NOW + RATE_LIMIT_COOLDOWN_MAX_MS * 2)).toBe(0);
  });
});

describe('adaptive concurrency', () => {
  it('stays out of the way until something throttles', () => {
    expect(effectiveConcurrency(NOW)).toBe(Number.POSITIVE_INFINITY);
  });

  it('floors immediately on a bot check', () => {
    onFailure('BOT_CHECK', 1, NOW);
    expect(effectiveConcurrency(NOW)).toBe(AIMD_MIN_CONCURRENCY);
  });

  it('halves on a throttle and never goes below one', () => {
    onFailure('BOT_CHECK', 1, NOW);
    for (let strike = 0; strike < 5; strike += 1) onFailure('RATE_LIMITED', 1, NOW);
    expect(effectiveConcurrency(NOW)).toBe(AIMD_MIN_CONCURRENCY);
  });

  it('eases back up one step at a time, not all at once', () => {
    onFailure('BOT_CHECK', 1, NOW);
    expect(effectiveConcurrency(NOW)).toBe(1);

    for (let success = 0; success < AIMD_INCREASE_AFTER_SUCCESSES; success += 1) onSuccess();
    expect(effectiveConcurrency(NOW)).toBe(2);
  });

  it('resets the strike count on a clean spawn', () => {
    onFailure('RATE_LIMITED', 1, NOW);
    onSuccess();
    expect(pacerState(NOW).strikes).toBe(0);
  });
});

describe('circuit breaker', () => {
  it('opens after repeated refusals and closes on its own', () => {
    for (let strike = 0; strike < CIRCUIT_STRIKES; strike += 1) onFailure('RATE_LIMITED', 1, NOW);

    // Without this, a hard block produces an hour of identical failures
    // instead of one message naming the cause.
    expect(circuitOpen(NOW)).toBe(true);
    expect(circuitOpen(NOW + CIRCUIT_OPEN_MS + 1)).toBe(false);
  });

  it('reports its state for check_health', () => {
    for (let strike = 0; strike < CIRCUIT_STRIKES; strike += 1) onFailure('RATE_LIMITED', 1, NOW);

    expect(pacerState(NOW)).toMatchObject({ circuitOpen: true, concurrency: AIMD_MIN_CONCURRENCY });
  });
});

describe('giving up', () => {
  it('stops at the policy attempt count', () => {
    expect(onFailure('RATE_LIMITED', 4, NOW).giveUp).toBe(false);
    expect(onFailure('RATE_LIMITED', 5, NOW).giveUp).toBe(true);
  });

  it('gives up immediately on a terminal code', () => {
    expect(onFailure('PRIVATE', 1, NOW).giveUp).toBe(true);
  });
});
