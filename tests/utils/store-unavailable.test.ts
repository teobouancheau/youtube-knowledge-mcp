import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home, tmpdir: actual.tmpdir };
});

// Stands in for a Node built without node:sqlite. Its own file because the
// mock has to be in place before the module is ever imported.
vi.mock('node:sqlite', () => {
  throw new Error("Cannot find module 'node:sqlite'");
});

import { getStore } from '../../src/utils/store.js';
import { YouTubeError } from '../../src/utils/errors.js';
import { checkHealthHandler } from '../../src/tools/check-health.js';
import { structuredOf } from '../helpers.js';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yk-nosqlite-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('a Node without node:sqlite', () => {
  it('fails the store with a typed error naming the version to install', async () => {
    const error: unknown = await getStore().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(YouTubeError);
    expect(error).toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(error).toHaveProperty('nextStep', expect.stringContaining('22.13.0'));
  });

  it('leaves check_health working, because the binaries it diagnoses are unaffected', async () => {
    // The whole point of the dynamic import: the other 37 tools must not care
    // that this Node cannot open a store.
    //
    // Deliberately does NOT assert on `ok`, which depends on whether yt-dlp is
    // installed on the machine running the tests — an earlier version of this
    // spec passed locally and failed in CI for exactly that reason. What
    // matters here is that the handler still answers, and reports the store as
    // unavailable rather than pretending it is empty.
    const result = await checkHealthHandler();
    const structured = structuredOf(result);

    expect(structured).toMatchObject({ store: { enabled: false } });
    expect(structured).toHaveProperty('ytDlp');
    expect(structured.store).toHaveProperty('error');
    expect(result.isError).toBeUndefined();
  });
});
