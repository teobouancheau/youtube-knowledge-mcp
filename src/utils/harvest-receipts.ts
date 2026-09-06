import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { coverageSchema, harvestScopeSchema, type Coverage } from '../harvest-schemas.js';
import { assertCoverageConsistent } from './coverage.js';
import { queryRow, queryRows, sqliteBoolean } from './store-rows.js';

/**
 * Persisting completeness receipts.
 *
 * Written in the same transaction as the rows they describe. That is the whole
 * reason this store is a database: there is no interval in which a receipt can
 * claim something the store does not hold, so the reconciliation dance that
 * `brain-build.ts` performs between its manifest and its chunks has no
 * analogue here.
 */

const receiptRowSchema = z.object({
  scope: harvestScopeSchema,
  target_id: z.string(),
  state: z.string(),
  reason: z.string(),
  have: z.number(),
  expected: z.number().nullable(),
  expected_source: z.string().nullable(),
  source: z.string(),
  limit_applied: z.number().nullable(),
  sort_applied: z.string().nullable(),
  ran_to_exhaustion: sqliteBoolean.nullable(),
  resume_token: z.string().nullable(),
  started_at: z.number(),
  finished_at: z.number().nullable(),
  attempts: z.number(),
  error_code: z.string().nullable(),
  note: z.string().nullable(),
});

const UPSERT = `
INSERT INTO harvest_receipt (
  scope, target_id, state, reason, have, expected, expected_source, source,
  limit_applied, sort_applied, ran_to_exhaustion, resume_token,
  started_at, finished_at, attempts, error_code, note
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(scope, target_id) DO UPDATE SET
  state = excluded.state, reason = excluded.reason, have = excluded.have,
  expected = excluded.expected, expected_source = excluded.expected_source,
  source = excluded.source, limit_applied = excluded.limit_applied,
  sort_applied = excluded.sort_applied, ran_to_exhaustion = excluded.ran_to_exhaustion,
  resume_token = excluded.resume_token, finished_at = excluded.finished_at,
  attempts = harvest_receipt.attempts + 1, error_code = excluded.error_code,
  note = excluded.note`;

/** `complete` is the receipt's own word; the rest describe how it ended. */
function stateOf(coverage: Coverage): string {
  if (coverage.complete) return 'complete';
  if (coverage.reason === 'SOURCE_REFUSED' || coverage.reason === 'TIMEOUT') return 'failed';
  if (coverage.reason === 'NOT_ATTEMPTED') return 'running';
  return 'partial';
}

function toRow(coverage: Coverage): Coverage {
  // Re-checked on the way to disk as well as on the way out of coverageOf: a
  // receipt that reaches storage wrong is one that will be believed later.
  assertCoverageConsistent(coverage);
  return coverage;
}

export function saveReceipt(
  database: DatabaseSync,
  coverage: Coverage,
  options: { startedAt?: number; errorCode?: string } = {}
): void {
  const checked = toRow(coverage);
  const finishedAt = Date.parse(checked.harvestedAt);

  database
    .prepare(UPSERT)
    .run(
      checked.scope,
      checked.targetId,
      stateOf(checked),
      checked.reason,
      checked.have,
      checked.expected ?? null,
      checked.expectedSource ?? null,
      checked.source,
      checked.limitApplied ?? null,
      checked.sortApplied ?? null,
      checked.ranToExhaustion === undefined ? null : Number(checked.ranToExhaustion),
      checked.resumeToken ?? null,
      options.startedAt ?? finishedAt,
      finishedAt,
      0,
      options.errorCode ?? null,
      checked.note ?? null
    );

  database
    .prepare(
      'INSERT INTO harvest_event (scope, target_id, at, state, delta, note) VALUES (?,?,?,?,?,?)'
    )
    .run(
      checked.scope,
      checked.targetId,
      finishedAt,
      stateOf(checked),
      checked.have,
      checked.reason
    );
}

function fromRow(row: z.infer<typeof receiptRowSchema>): Coverage {
  const expected = row.expected;
  const expectedSource = row.expected_source;

  return coverageSchema.parse({
    scope: row.scope,
    targetId: row.target_id,
    complete: row.state === 'complete',
    reason: row.reason,
    have: row.have,
    ...(expected === null || expectedSource === null ? {} : { expected, expectedSource }),
    ...(row.ran_to_exhaustion === null ? {} : { ranToExhaustion: row.ran_to_exhaustion }),
    source: row.source,
    harvestedAt: new Date(row.finished_at ?? row.started_at).toISOString(),
    ...(row.limit_applied === null ? {} : { limitApplied: row.limit_applied }),
    ...(row.sort_applied === null ? {} : { sortApplied: row.sort_applied }),
    ...(row.resume_token === null ? {} : { resumeToken: row.resume_token }),
    ...(row.note === null ? {} : { note: row.note }),
  });
}

export function readReceipt(
  database: DatabaseSync,
  scope: Coverage['scope'],
  targetId: string
): Coverage | undefined {
  const row = queryRow(
    database.prepare('SELECT * FROM harvest_receipt WHERE scope = ? AND target_id = ?'),
    receiptRowSchema,
    scope,
    targetId
  );
  return row === undefined ? undefined : fromRow(row);
}

export function listReceipts(
  database: DatabaseSync,
  options: { scope?: Coverage['scope']; limit?: number; offset?: number } = {}
): Coverage[] {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const rows =
    options.scope === undefined
      ? queryRows(
          database.prepare(
            'SELECT * FROM harvest_receipt ORDER BY finished_at DESC, target_id LIMIT ? OFFSET ?'
          ),
          receiptRowSchema,
          limit,
          offset
        )
      : queryRows(
          database.prepare(
            'SELECT * FROM harvest_receipt WHERE scope = ? ORDER BY finished_at DESC, target_id LIMIT ? OFFSET ?'
          ),
          receiptRowSchema,
          options.scope,
          limit,
          offset
        );

  return rows.map(fromRow);
}

export function countReceipts(database: DatabaseSync, scope?: Coverage['scope']): number {
  const row =
    scope === undefined
      ? queryRow(
          database.prepare('SELECT COUNT(*) AS n FROM harvest_receipt'),
          z.object({ n: z.number() })
        )
      : queryRow(
          database.prepare('SELECT COUNT(*) AS n FROM harvest_receipt WHERE scope = ?'),
          z.object({ n: z.number() }),
          scope
        );
  return row?.n ?? 0;
}
