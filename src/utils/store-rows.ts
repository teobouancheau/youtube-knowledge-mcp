import type { StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { YouTubeError } from './errors.js';

/**
 * Reading rows back out of the store, validated.
 *
 * `StatementSync.all()` is typed `Record<string, SQLOutputValue>[]` — usefully
 * honest, and unusable directly. Every read goes through a zod schema here,
 * the same contract `readJsonFile` and `parseYtDlpJson` already apply to the
 * other two places untyped data enters this server. No `as` anywhere.
 */

/**
 * SQLite `STRICT` tables have no BOOLEAN, so flags are stored as 0 or 1.
 * Decoded with an explicit transform rather than a cast, which also rejects a
 * 2 that some future writer might smuggle in.
 */
export const sqliteBoolean = z
  .union([z.literal(0), z.literal(1)])
  .transform((value) => value === 1);

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(row)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Runs a statement and validates every row.
 *
 * A row that does not match is a bug in this server, not something a caller
 * can fix, so it fails loudly rather than being skipped — the opposite of
 * `recordOfValid`, which drops a bad entry because there the bad entry came
 * from YouTube.
 */
function parseAll<T extends z.ZodTypeAny>(schema: T, rows: unknown[]): z.output<T>[] {
  const parsed = z.array(schema).safeParse(rows);
  if (parsed.success) return parsed.data;

  throw new YouTubeError(
    'MALFORMED_RESPONSE',
    'A row in the harvested store had an unexpected shape.',
    {
      nextStep: `This is a bug in the server, not in your request. Details: ${describe(parsed.error)}`,
    }
  );
}

export function queryRows<T extends z.ZodTypeAny>(
  statement: StatementSync,
  schema: T,
  ...params: readonly (string | number | null)[]
): z.output<T>[] {
  return parseAll(schema, statement.all(...params));
}

/** The single-row form. Returns undefined when the statement matched nothing. */
export function queryRow<T extends z.ZodTypeAny>(
  statement: StatementSync,
  schema: T,
  ...params: readonly (string | number | null)[]
): z.output<T> | undefined {
  const row = statement.get(...params);
  if (row === undefined) return undefined;

  // Parsed through `z.array(schema)` rather than `schema` directly: a bare
  // generic `safeParse` widens its result to `any`, which would let every
  // later misuse through unchecked. This also shares one error message.
  return parseAll(schema, [row])[0];
}

/** `SELECT COUNT(*)` is the one query whose shape is always the same. */
export function countRows(
  statement: StatementSync,
  ...params: readonly (string | number | null)[]
): number {
  const row = queryRow(statement, z.object({}).passthrough(), ...params);
  if (row === undefined) return 0;

  const first = Object.values(row)[0];
  return typeof first === 'number' ? first : 0;
}
