import type { DatabaseSync } from 'node:sqlite';
import { STORE_VERSION } from './store-schema.js';
import { writeUserVersion } from './store.js';

/**
 * Ordered schema migrations for the harvested store.
 *
 * `PRAGMA user_version` carries the store's version, deliberately independent
 * of the server's semver: the schema changes far less often than the code, and
 * tying them together would force an empty migration on every release.
 *
 * Version 0 means "no store yet". Creating the tables is `STORE_SCHEMA`'s job,
 * not a migration's, so the first run only stamps the version.
 */

export interface StoreMigration {
  /** The version this migration produces. */
  to: number;
  apply: (database: DatabaseSync) => void;
}

/**
 * Empty on purpose at v1: `STORE_SCHEMA` is `CREATE TABLE IF NOT EXISTS`
 * throughout, so a fresh database and an existing v1 database converge without
 * one. The list exists so the second schema change is a one-line addition
 * rather than a retrofit.
 */
export const STORE_MIGRATIONS: readonly StoreMigration[] = [];

/**
 * Brings a database up to STORE_VERSION.
 *
 * Each migration runs inside its own transaction so a failure leaves the
 * store at the last version that fully applied, rather than half-way through
 * one. A newer-than-known version is rejected before this is reached, in
 * `store.ts`.
 */
export function runStoreMigrations(database: DatabaseSync, fromVersion: number): number {
  let current = fromVersion;

  for (const migration of STORE_MIGRATIONS) {
    if (migration.to <= current) continue;

    database.exec('BEGIN');
    try {
      migration.apply(database);
      writeUserVersion(database, migration.to);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    current = migration.to;
  }

  if (current !== STORE_VERSION) {
    writeUserVersion(database, STORE_VERSION);
    current = STORE_VERSION;
  }

  return current;
}
