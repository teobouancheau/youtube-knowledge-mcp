import {
  coverageSchema,
  type Coverage,
  type CompletenessReason,
  type ExpectedSource,
  type HarvestScope,
} from '../harvest-schemas.js';

/**
 * The one constructor for a completeness receipt.
 *
 * A wrong `complete: true` is the worst thing this server can emit: it is the
 * difference between a consumer saying "here is a sample of the comments" and
 * "here is the video's full comment history". So `complete` is not a field a
 * caller sets — it is derived here, and the derivation is guarded by
 * invariants that are asserted in code rather than merely documented.
 *
 * The rule that does the most work: `expected` is what the SOURCE said, and is
 * never derived from `have`. Copying the number we collected into the field
 * that means "how many there are" would turn "we stopped" into "there was
 * nothing more", silently, and every check downstream would agree with it.
 */

/** A complete receipt is still only as fresh as its harvest; comments accrue. */
export const RECEIPT_STALE_MS = 7 * 86_400_000;

/** Beyond this, receipts are summarised rather than listed in a tool result. */
export const COVERAGE_IN_RESULT_LIMIT = 100;

export interface ExpectedTotal {
  value: number;
  source: ExpectedSource;
}

export interface CoverageInput {
  scope: HarvestScope;
  targetId: string;
  have: number;
  source: string;
  /**
   * Only ever an explicit pair or nothing. There is deliberately no code path
   * that accepts a bare number, because the number would have to come from
   * somewhere and `have` is the nearest thing to hand.
   */
  expected?: ExpectedTotal;
  ranToExhaustion?: boolean;
  reason?: CompletenessReason;
  limitApplied?: number;
  sortApplied?: 'top' | 'new';
  resumeToken?: string;
  harvestedAt?: Date;
  note?: string;
}

/** Thrown for a receipt that contradicts itself. Not a YouTubeError: no caller can fix it. */
export class CoverageInvariantError extends Error {
  constructor(message: string) {
    super(`Coverage invariant violated: ${message}`);
    this.name = 'CoverageInvariantError';
  }
}

function capWasBinding(input: CoverageInput): boolean {
  return input.limitApplied !== undefined && input.have >= input.limitApplied;
}

/**
 * Whether this server can prove it holds everything in scope.
 *
 * Two independent ways to prove it, and a cap overrides both:
 *
 *   - the source stated a total and we hold at least that many, or
 *   - the source's own iteration ran out (`source-exhausted`).
 *
 * Exhaustion alone is not proof. Measured against yt-dlp 2026.08.19: a run
 * capped at 40 parent comments returned a non-null `comment_count` of 58,
 * because `itertools.islice` ends iteration at the cap exactly as a natural
 * end would. So a binding cap disqualifies completeness even when the source
 * says it finished.
 */
function isProvablyComplete(input: CoverageInput): boolean {
  if (capWasBinding(input)) return false;

  if (input.expected !== undefined) {
    if (input.expected.source === 'source-exhausted') return input.ranToExhaustion !== false;
    return input.have >= input.expected.value;
  }

  return false;
}

function derivedReason(input: CoverageInput, complete: boolean): CompletenessReason {
  if (complete) return 'COMPLETE';
  if (input.reason !== undefined && input.reason !== 'COMPLETE') return input.reason;
  if (capWasBinding(input)) return 'CAP_REACHED';
  // Nothing said there was more, and nothing proved there was not. That is not
  // completeness; it is the absence of evidence, and it has its own name.
  return 'SOURCE_SILENT';
}

/**
 * Checks a receipt against every invariant.
 *
 * Called inside `coverageOf` and again by handlers before a result goes out,
 * because the cost of the second call is nothing and the cost of a wrong
 * `complete: true` reaching a consumer is the whole point of this module.
 */
export function assertCoverageConsistent(coverage: Coverage): void {
  const fail = (message: string): never => {
    throw new CoverageInvariantError(message);
  };

  if (coverage.complete && coverage.reason !== 'COMPLETE') {
    fail(`complete is true but reason is ${coverage.reason}`);
  }
  if (!coverage.complete && coverage.reason === 'COMPLETE') {
    fail('reason is COMPLETE but complete is false');
  }
  if ((coverage.expected === undefined) !== (coverage.expectedSource === undefined)) {
    fail('expected and expectedSource must be present or absent together');
  }
  if (coverage.complete) {
    const exhausted = coverage.expectedSource === 'source-exhausted';
    const enough = coverage.expected !== undefined && coverage.have >= coverage.expected;
    if (!exhausted && !enough) {
      fail('complete is true without either a met expected total or an exhausted source');
    }
  }
  // There is deliberately no separate "COMPLETE without an expected total"
  // guard. It reads like a necessary invariant and is unreachable: reaching it
  // needs reason COMPLETE, which the checks above already force to pair with
  // complete:true, which in turn already demands either a met total or an
  // exhausted source. An unreachable guard is not defence in depth, it is code
  // no test can justify.
  // One-directional on purpose. "A token exactly when incomplete" is the
  // tempting symmetry, and it is wrong: plenty of incomplete receipts have
  // nothing to resume — SOURCE_REFUSED, COMMENTS_DISABLED, a caller that
  // simply did not supply one. What must never happen is a token on a
  // complete receipt, which would invite a caller to page past the end.
  if (coverage.resumeToken !== undefined && coverage.complete) {
    fail('a complete receipt cannot carry a resumeToken');
  }
  if (
    coverage.limitApplied !== undefined &&
    coverage.have >= coverage.limitApplied &&
    coverage.reason === 'COMPLETE'
  ) {
    fail('a binding cap cannot produce COMPLETE');
  }
}

/** Builds a validated receipt. The only way to make one. */
export function coverageOf(input: CoverageInput): Coverage {
  const complete = isProvablyComplete(input);
  const reason = derivedReason(input, complete);
  const harvestedAt = input.harvestedAt ?? new Date();

  const coverage = coverageSchema.parse({
    scope: input.scope,
    targetId: input.targetId,
    complete,
    reason,
    have: input.have,
    ...(input.expected === undefined
      ? {}
      : { expected: input.expected.value, expectedSource: input.expected.source }),
    ...(input.ranToExhaustion === undefined ? {} : { ranToExhaustion: input.ranToExhaustion }),
    source: input.source,
    harvestedAt: harvestedAt.toISOString(),
    ...(complete
      ? { staleAfter: new Date(harvestedAt.getTime() + RECEIPT_STALE_MS).toISOString() }
      : {}),
    ...(input.limitApplied === undefined ? {} : { limitApplied: input.limitApplied }),
    ...(input.sortApplied === undefined ? {} : { sortApplied: input.sortApplied }),
    // A resume token is meaningless on a complete receipt, and its absence is
    // how a caller knows there is nothing left to ask for.
    ...(complete || input.resumeToken === undefined ? {} : { resumeToken: input.resumeToken }),
    ...(input.note === undefined ? {} : { note: input.note }),
  });

  assertCoverageConsistent(coverage);
  return coverage;
}
