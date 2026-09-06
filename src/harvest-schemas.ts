import { z } from 'zod';

/**
 * The shapes a completeness receipt is made of.
 *
 * This server exists to extract everything YouTube will serve, and the failure
 * mode that matters is not "we got 3%" — it is "we got 3% and reported 100%".
 * A receipt travels with every extraction result so a consumer can never
 * describe a sample as a full history by accident.
 *
 * The invariants that make `complete` mean something live in
 * `utils/coverage.ts`, which is the only place allowed to build one.
 */

export const harvestScopeSchema = z.enum([
  /** Which videos a channel has. */
  'channel-catalog',
  /** Full per-video metadata snapshots. */
  'video-details',
  /** Comments and replies for one video. */
  'video-comments',
]);
export type HarvestScope = z.infer<typeof harvestScopeSchema>;

export const completenessReasonSchema = z.enum([
  /** Provably everything: the source stated a total and we hold it, or the source ran out. */
  'COMPLETE',
  /** The caller's own limit stopped it. */
  'CAP_REACHED',
  /** The wall-clock budget for this call ran out. */
  'BUDGET_SPENT',
  /** YouTube throttled this client. */
  'RATE_LIMITED',
  /** The MCP client aborted the request. */
  'CANCELLED',
  'TIMEOUT',
  /** BOT_CHECK, LOGIN_REQUIRED, PRIVATE, AGE_GATED or MEMBERS_ONLY. */
  'SOURCE_REFUSED',
  /** Comments are turned off for this video, so zero is the true total. */
  'COMMENTS_DISABLED',
  /** The source states no total, so exhaustion is unprovable. */
  'SOURCE_SILENT',
  /** Some items failed; each cost only itself. */
  'PARTIAL_ERROR',
  'NOT_ATTEMPTED',
]);
export type CompletenessReason = z.infer<typeof completenessReasonSchema>;

/**
 * Where a total came from.
 *
 * `source-exhausted` is the one value that is not a number YouTube reported:
 * it means the listing ended on its own, which is its own kind of proof.
 */
export const expectedSourceSchema = z.enum([
  'youtube:comment_count',
  'youtube:playlist_count',
  'source-exhausted',
]);
export type ExpectedSource = z.infer<typeof expectedSourceSchema>;

export const coverageSchema = z.object({
  scope: harvestScopeSchema,
  targetId: z.string().describe('Channel id for a catalog, video id for details or comments'),

  complete: z
    .boolean()
    .describe(
      'True ONLY when this server can prove it holds every item in scope. False means the ' +
        'data is a SAMPLE. A consumer must not describe it as a full history while this is false.'
    ),

  reason: completenessReasonSchema.describe(
    'Why complete is what it is. Always present, including when complete is true.'
  ),

  have: z
    .number()
    .int()
    .nonnegative()
    .describe('Items this store actually holds for this target, counted from the store.'),

  expected: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'The total the SOURCE states. Absent when the source states none — never inferred, ' +
        'never copied from have. Absent with complete:false means "unknown how much is missing".'
    ),

  expectedSource: expectedSourceSchema
    .optional()
    .describe('Where expected came from. Absent if and only if expected is absent.'),

  ranToExhaustion: z
    .boolean()
    .optional()
    .describe(
      "Whether the source's own iteration finished rather than being cut off. Necessary for " +
        'completeness but not sufficient: a cap also ends iteration.'
    ),

  source: z.string().describe('The exact extraction path, including tool version and flags.'),

  harvestedAt: z.string().describe('ISO-8601 of the last item written for this target'),

  staleAfter: z
    .string()
    .optional()
    .describe(
      'ISO-8601 after which this should be re-checked. Comments accrue, so a complete ' +
        'receipt goes stale without becoming wrong.'
    ),

  limitApplied: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The cap the caller asked for. Present if and only if one was applied.'),

  sortApplied: z
    .enum(['top', 'new'])
    .optional()
    .describe(
      'Ordering the source applied. A capped "top" harvest is a BIASED PREFIX of a stream, ' +
        'not a random sample.'
    ),

  resumeToken: z
    .string()
    .optional()
    .describe('Opaque. Pass to the same tool to continue. Absent if and only if complete.'),

  note: z.string().optional(),
});
export type Coverage = z.infer<typeof coverageSchema>;
