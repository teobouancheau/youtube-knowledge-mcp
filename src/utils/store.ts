import type { DatabaseSync } from 'node:sqlite';
import { chmod, rename } from 'node:fs/promises';
import { YouTubeError } from './errors.js';
import { ensurePrivateDir } from './paths.js';
import { corruptStorePath, storeDatabasePath, storeDir } from './store-paths.js';
import { STORE_PRAGMAS, STORE_SCHEMA, STORE_VERSION } from './store-schema.js';
import { runStoreMigrations } from './store-migrations.js';

/**
 * The one connection to the harvested store.
 *
 * `node:sqlite` is a runtime builtin, so this adds nothing to package.json —
 * the same category as `node:fs`. It is reached through a dynamic import
 * behind an async accessor so that a Node without it still loads every module
 * and still serves the tools that do not touch the store; only the harvest
 * tools fail, with a sentence naming the version to install.
 *
 * The reason for a database rather than more JSON files is transactional
 * receipts. `brain-build.ts` carries a long comment explaining that its
 * manifest and its chunks are two documents, only one can be written first,
 * and a crash in between strands a brain. Here the rows and the receipt that
 * describes them commit together, so that failure is not representable.
 */

/** The exact Node where `node:sqlite` is unflagged and `StatementSync.iterate()` exists. */
export const MIN_NODE_VERSION = '22.13.0';

const BUSY_TIMEOUT_MS = 5_000;
const PRIVATE_FILE_MODE = 0o600;

let db: DatabaseSync | undefined;
let warningFilterInstalled = false;

/**
 * Silence only Node's own "SQLite is experimental" notice.
 *
 * It goes to stderr, so it cannot corrupt the stdio protocol, but it is noise
 * in every client's log. Matched on both the name and the message so that an
 * unrelated ExperimentalWarning still reaches whoever was listening for it.
 *
 * Only listeners registered before the first store open are wrapped — which is
 * the one that matters, Node's own default printer. A listener added later
 * sees every warning, including this one, and that is the right trade: this
 * exists to quieten a default, not to hide a warning from someone who went
 * looking for it.
 */
function installWarningFilter(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;

  const existing = process.listeners('warning');
  for (const listener of existing) process.removeListener('warning', listener);

  process.on('warning', (warning: Error) => {
    if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
    for (const listener of existing) listener(warning);
  });
}

async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  try {
    installWarningFilter();
    // Annotated rather than inferred: a bare dynamic import widens to `any`,
    // which would let every later misuse of the module through unchecked.
    const sqlite: typeof import('node:sqlite') = await import('node:sqlite');
    return sqlite;
  } catch {
    throw new YouTubeError(
      'STORE_UNAVAILABLE',
      'This Node build has no node:sqlite, which the harvest tools need.',
      {
        nextStep: `Install Node ${MIN_NODE_VERSION} or newer (this process is ${process.version}). Every other tool works without it.`,
      }
    );
  }
}

function isCorruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(message);
}

function assertUsableVersion(found: number): void {
  if (found <= STORE_VERSION) return;

  // Operating on a schema written by a newer server is how data gets
  // destroyed. Refusing is the only safe move, and naming both versions is
  // what makes the refusal actionable.
  throw new YouTubeError(
    'STORE_CORRUPT',
    `This store was written by a newer version of the server (store v${String(found)}; this build understands v${String(STORE_VERSION)}).`,
    { nextStep: 'Upgrade youtube-knowledge-mcp, or point HOME at a different data directory.' }
  );
}

async function openDatabase(): Promise<DatabaseSync> {
  const sqlite = await loadSqlite();
  await ensurePrivateDir(storeDir());
  const path = storeDatabasePath();

  let opened: DatabaseSync;
  try {
    opened = new sqlite.DatabaseSync(path, {
      timeout: BUSY_TIMEOUT_MS,
      enableForeignKeyConstraints: true,
    });
    for (const pragma of STORE_PRAGMAS) opened.exec(pragma);
  } catch (error) {
    if (!isCorruption(error)) throw error;
    throw new YouTubeError('STORE_CORRUPT', 'The harvested store could not be opened.', {
      nextStep: 'Call repair_store to move the damaged file aside and start a fresh store.',
      cause: error,
    });
  }

  const version = readUserVersion(opened);
  assertUsableVersion(version);
  opened.exec(STORE_SCHEMA);
  runStoreMigrations(opened, version);

  // The database holds harvested personal data — commenter names, ids and
  // free text — so it gets the same bits as the transcript cache rather than
  // the umask default.
  await chmod(path, PRIVATE_FILE_MODE).catch(() => undefined);
  return opened;
}

export function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get();
  const value = row?.user_version;
  return typeof value === 'number' ? value : 0;
}

export function writeUserVersion(database: DatabaseSync, version: number): void {
  // PRAGMA does not accept a bound parameter, so the value is constrained to an
  // integer here rather than interpolated from anything a caller controls.
  database.exec(`PRAGMA user_version = ${String(Math.trunc(version))}`);
}

/** The process-wide store connection, opened on first use. */
export async function getStore(): Promise<DatabaseSync> {
  db ??= await openDatabase();
  return db;
}

export function closeStore(): void {
  db?.close();
  db = undefined;
}

/**
 * Moves a damaged database aside and starts a fresh one.
 *
 * Renames rather than deletes. Unlike `search-index.json`, which is derivable
 * and is correctly rebuilt from disk, a harvest costs hours of network that no
 * local cache can replay — so nothing here removes one without being asked.
 */
export async function quarantineStore(now = Date.now()): Promise<string> {
  closeStore();
  const target = corruptStorePath(now);
  await rename(storeDatabasePath(), target);
  return target;
}

/** Runs `work` in a transaction, rolling back if it throws. */
export function inTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
