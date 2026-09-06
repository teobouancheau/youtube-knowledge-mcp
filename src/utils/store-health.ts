import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { countRows, queryRow } from './store-rows.js';
import { getStore, readUserVersion } from './store.js';
import { storeDatabasePath } from './store-paths.js';
import { STORE_VERSION } from './store-schema.js';

/**
 * What can be said about the store without harvesting anything.
 *
 * Integrity is checked here and nowhere else on the hot path: `quick_check` is
 * bounded and catches the realistic failures, while the full `integrity_check`
 * is O(database) and would add seconds to every server start on a store that
 * is measured in gigabytes.
 */

export interface StoreHealth {
  enabled: boolean;
  path: string;
  exists: boolean;
  storeVersion?: number;
  sizeBytes: number;
  walBytes: number;
  integrity: 'ok' | 'failed' | 'unchecked';
  channels: number;
  videos: number;
  comments: number;
  receipts: { complete: number; partial: number; running: number; failed: number };
  error?: string;
}

const quickCheckSchema = z.object({ quick_check: z.string() }).passthrough();
const stateCountSchema = z.object({ state: z.string(), n: z.number() }).passthrough();

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function emptyReceipts(): StoreHealth['receipts'] {
  return { complete: 0, partial: 0, running: 0, failed: 0 };
}

export async function readStoreHealth(): Promise<StoreHealth> {
  const path = storeDatabasePath();
  const [sizeBytes, walBytes] = await Promise.all([sizeOf(path), sizeOf(`${path}-wal`)]);

  const base: StoreHealth = {
    enabled: true,
    path,
    exists: sizeBytes > 0,
    sizeBytes,
    // A -wal file that never shrinks means a reader is pinning it, which is
    // worth seeing before it becomes a disk-space surprise.
    walBytes,
    integrity: 'unchecked',
    channels: 0,
    videos: 0,
    comments: 0,
    receipts: emptyReceipts(),
  };

  try {
    const store = await getStore();
    const quick = queryRow(store.prepare('PRAGMA quick_check'), quickCheckSchema);

    const receipts = emptyReceipts();
    for (const row of store
      .prepare('SELECT state, COUNT(*) AS n FROM harvest_receipt GROUP BY state')
      .all()) {
      const parsed = stateCountSchema.safeParse(row);
      if (!parsed.success) continue;

      // A `state` this build does not know about is counted nowhere rather
      // than crashing: the enum is allowed to grow ahead of this reader.
      const { state, n } = parsed.data;
      if (state === 'complete') receipts.complete = n;
      else if (state === 'partial') receipts.partial = n;
      else if (state === 'running') receipts.running = n;
      else if (state === 'failed') receipts.failed = n;
    }

    return {
      ...base,
      storeVersion: readUserVersion(store),
      integrity: quick?.quick_check === 'ok' ? 'ok' : 'failed',
      channels: countRows(store.prepare('SELECT COUNT(*) FROM channel')),
      videos: countRows(store.prepare('SELECT COUNT(*) FROM video')),
      comments: countRows(store.prepare('SELECT COUNT(*) FROM comment')),
      receipts,
    };
  } catch (error) {
    // A store that cannot be opened is a reportable condition, not a reason
    // for check_health itself to fail: the binaries it exists to diagnose are
    // unaffected.
    return {
      ...base,
      enabled: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Whether the store should make an overall health report say "not ready".
 *
 * A missing store must not: a fresh install has none, and check_health's job
 * is diagnosing the external binaries. A store that fails its integrity check,
 * or claims a version this build does not understand, must.
 */
export function storeFailsHealth(health: StoreHealth): boolean {
  if (health.integrity === 'failed') return true;
  return health.storeVersion !== undefined && health.storeVersion > STORE_VERSION;
}
