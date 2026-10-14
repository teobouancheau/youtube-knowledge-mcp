import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The local gates, as the hooks wire them.
 *
 * What a push has to pass is written in `.husky/pre-push` and nowhere else checks it, so a
 * line dropped from it would quietly weaken every later push. These assertions are what
 * make dropping one a failing test rather than a silent change.
 */

const ROOT = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf-8');
const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

describe('the pre-push gate', () => {
  const lines = read('.husky/pre-push').trim().split('\n');

  it('scans the history for secrets, audits dependencies, validates, then smoke-tests the build', () => {
    expect(lines).toEqual([
      'sh scripts/secret-scan.sh history',
      'npm run audit',
      'npm run validate',
      'npm run smoke',
    ]);
  });

  it('only calls scripts that exist', () => {
    const called = lines.flatMap((line) => {
      const name = /^npm run (\S+)$/.exec(line)?.[1];
      return name === undefined ? [] : [name];
    });

    expect(called.length).toBeGreaterThan(0);
    expect(called.filter((name) => !(name in scripts))).toEqual([]);
  });
});

describe('the dependency audit', () => {
  it('fails on anything moderate or worse, in the hook and in CI alike', () => {
    expect(scripts.audit).toBe('npm audit --audit-level=moderate');
    expect(read('.github/workflows/ci.yml')).toContain('run: npm run audit');
  });
});

describe('the smoke check', () => {
  it('builds first, so it never tests a stale dist', () => {
    expect(scripts.smoke).toBe('npm run build && node scripts/smoke.mjs');
  });
});
