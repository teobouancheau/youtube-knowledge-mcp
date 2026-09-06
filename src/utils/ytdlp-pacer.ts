import type { YouTubeErrorCode } from './errors.js';

/**
 * How this server reacts to being throttled.
 *
 * The old behaviour was three attempts with at most ~1.5 seconds of jitter and
 * no memory between calls, which is fine for a blip and useless for an
 * hour-long harvest: nothing slowed down, nothing waited, and a hard block
 * produced an hour of identical failures.
 *
 * This adds three things that only make sense across calls — a shared
 * cooldown, an adaptive concurrency ceiling, and a circuit breaker — so the
 * state is deliberately process-global, the same scope as the limiter it
 * cooperates with.
 */

export const RATE_LIMIT_COOLDOWN_BASE_MS = 30_000;
export const RATE_LIMIT_COOLDOWN_MAX_MS = 15 * 60_000;
export const BOT_CHECK_COOLDOWN_MS = 10 * 60_000;
export const MAX_BACKOFF_MS = 120_000;
export const BASE_BACKOFF_MS = 750;

export const AIMD_MIN_CONCURRENCY = 1;
export const AIMD_INCREASE_AFTER_SUCCESSES = 20;
export const AIMD_DECREASE_FACTOR = 0.5;

/** Consecutive throttles before a global cooldown starts. */
export const COOLDOWN_AFTER_STRIKES = 2;

export const CIRCUIT_STRIKES = 5;
export const CIRCUIT_OPEN_MS = 5 * 60_000;

interface RetryPolicy {
  /** Total spawns, including the first. */
  attempts: number;
  backoff: 'none' | 'jitter' | 'exponential';
  cooldown: 'none' | 'rate-limit' | 'bot-check';
  concurrency: 'none' | 'decrease' | 'floor';
}

const TERMINAL: RetryPolicy = {
  attempts: 1,
  backoff: 'none',
  cooldown: 'none',
  concurrency: 'none',
};

/**
 * What to do about each kind of failure.
 *
 * BOT_CHECK does not retry, and that is measured rather than assumed: from a
 * datacenter address, eight player clients, a fifteen-minute cooldown, a PO
 * token provider and curl_cffi TLS impersonation all returned the same answer.
 * Retrying spends requests on a known-dead path; stopping and naming the cause
 * is the useful response. The cooldown still applies, because whatever else is
 * in flight should not keep hammering.
 */
const POLICIES: Partial<Record<YouTubeErrorCode, RetryPolicy>> = {
  RATE_LIMITED: {
    attempts: 5,
    backoff: 'exponential',
    cooldown: 'rate-limit',
    concurrency: 'decrease',
  },
  BOT_CHECK: { attempts: 1, backoff: 'none', cooldown: 'bot-check', concurrency: 'floor' },
  TIMEOUT: { attempts: 3, backoff: 'exponential', cooldown: 'none', concurrency: 'decrease' },
  YTDLP_FAILED: { attempts: 2, backoff: 'jitter', cooldown: 'none', concurrency: 'none' },
};

export function policyFor(code: YouTubeErrorCode): RetryPolicy {
  return POLICIES[code] ?? TERMINAL;
}

interface PacerState {
  cooldownUntil: number;
  circuitOpenUntil: number;
  strikes: number;
  successes: number;
  concurrency: number;
}

let state: PacerState = {
  cooldownUntil: 0,
  circuitOpenUntil: 0,
  strikes: 0,
  successes: 0,
  concurrency: Number.POSITIVE_INFINITY,
};

/** ±25% so parallel callers do not come back in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function cooldownFor(kind: RetryPolicy['cooldown'], strikes: number): number {
  if (kind === 'none') return 0;
  if (kind === 'bot-check') return BOT_CHECK_COOLDOWN_MS;

  const escalated = RATE_LIMIT_COOLDOWN_BASE_MS * 2 ** Math.max(0, strikes - 1);
  return jitter(Math.min(escalated, RATE_LIMIT_COOLDOWN_MAX_MS));
}

export function backoffDelay(attempt: number, style: RetryPolicy['backoff']): number {
  if (style === 'none') return 0;
  if (style === 'jitter') return Math.round(Math.random() * BASE_BACKOFF_MS);

  // Exponential with full jitter, capped so a long run cannot stall for hours.
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(Math.random() * ceiling);
}

export interface PacerDecision {
  giveUp: boolean;
  delayMs: number;
}

/** Records a failure and says whether to try again, and after how long. */
export function onFailure(
  code: YouTubeErrorCode,
  attempt: number,
  now = Date.now()
): PacerDecision {
  const policy = policyFor(code);
  const throttled = policy.cooldown !== 'none';

  if (throttled) {
    state.strikes += 1;
    state.successes = 0;

    // A first strike gets the exponential backoff and nothing more: one 429 is
    // a blip, and making a single interactive call wait out a 30-second global
    // cooldown would be worse than the problem. The cooldown starts once the
    // client has been refused twice in a row, which is when it has stopped
    // being a blip. A bot check skips the grace: it was measured not to clear
    // on its own, so there is nothing to be gained by trying again sooner.
    const grace = policy.cooldown === 'bot-check' ? 1 : COOLDOWN_AFTER_STRIKES;
    if (state.strikes >= grace) {
      state.cooldownUntil = Math.max(
        state.cooldownUntil,
        now + cooldownFor(policy.cooldown, state.strikes)
      );
    }

    if (policy.concurrency === 'floor') {
      state.concurrency = AIMD_MIN_CONCURRENCY;
    } else if (policy.concurrency === 'decrease') {
      state.concurrency = Math.max(
        AIMD_MIN_CONCURRENCY,
        Math.floor(effectiveConcurrency(now) * AIMD_DECREASE_FACTOR)
      );
    }

    if (state.strikes >= CIRCUIT_STRIKES) {
      state.circuitOpenUntil = now + CIRCUIT_OPEN_MS;
    }
  }

  return attempt >= policy.attempts
    ? { giveUp: true, delayMs: 0 }
    : { giveUp: false, delayMs: backoffDelay(attempt, policy.backoff) };
}

/** Records a clean spawn, easing the ceiling back up one step at a time. */
export function onSuccess(): void {
  state.strikes = 0;
  state.successes += 1;

  if (state.successes >= AIMD_INCREASE_AFTER_SUCCESSES) {
    state.successes = 0;
    if (Number.isFinite(state.concurrency)) state.concurrency += 1;
  }
}

/** How long a caller should wait before spawning, in milliseconds. */
export function waitMs(now = Date.now()): number {
  if (state.circuitOpenUntil > now) return state.circuitOpenUntil - now;
  return Math.max(0, state.cooldownUntil - now);
}

export function circuitOpen(now = Date.now()): boolean {
  return state.circuitOpenUntil > now;
}

/**
 * The ceiling the limiter should honour right now.
 *
 * Infinite until something throttles us, so an untroubled server runs at
 * whatever YOUTUBE_MCP_MAX_CONCURRENCY allows and the limiter stays the only
 * authority on the normal case.
 */
export function effectiveConcurrency(now = Date.now()): number {
  if (circuitOpen(now)) return AIMD_MIN_CONCURRENCY;
  return state.concurrency;
}

export function pacerState(now = Date.now()): {
  cooldownMs: number;
  circuitOpen: boolean;
  strikes: number;
  concurrency: number;
} {
  return {
    cooldownMs: waitMs(now),
    circuitOpen: circuitOpen(now),
    strikes: state.strikes,
    concurrency: effectiveConcurrency(now),
  };
}

/** Test seam; the pacer is process-global in normal use. */
export function resetPacer(): void {
  state = {
    cooldownUntil: 0,
    circuitOpenUntil: 0,
    strikes: 0,
    successes: 0,
    concurrency: Number.POSITIVE_INFINITY,
  };
}
