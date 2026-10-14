import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The secret-scanning gate, as the hooks and `npm run validate` use it.
 *
 * The wiring is checked by reading the files that carry it, and the behaviour by running
 * the real script against a throwaway repository holding a made-up token. The token is
 * assembled here, at run time, so this file never contains a string a scanner would flag.
 */

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'secret-scan.sh');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf-8');

const hasGitleaks = ((): boolean => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** A GitHub personal-access-token shape, which gitleaks' default rules recognise. */
const FAKE_TOKEN = ['ghp', 'R8q4Zk2LmN7xWvB1cYd5Hs9TeJfUa3GoPiXr'].join('_');

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function scan(
  mode: string,
  env: NodeJS.ProcessEnv = process.env
): { code: number; output: string } {
  const result = spawnSync('/bin/sh', [SCRIPT, mode], { cwd: repo, env, encoding: 'utf-8' });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'yk-secrets-'));
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, '.gitleaks.toml'), read('.gitleaks.toml'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('the gate is wired in where commits and pushes pass', () => {
  it('scans what is staged before every commit, ahead of the other pre-commit work', () => {
    const lines = read('.husky/pre-commit').trim().split('\n');

    expect(lines[0]).toBe('sh scripts/secret-scan.sh staged');
    expect(lines).toContain('npx lint-staged');
  });

  it('scans everything about to be pushed before every push', () => {
    expect(read('.husky/pre-push')).toContain('sh scripts/secret-scan.sh history');
  });

  it('is part of validate, so a release cannot skip it', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;

    expect(scripts.secrets).toBe('sh scripts/secret-scan.sh tree');
    expect(scripts.validate).toMatch(/^npm run secrets && /);
  });

  it('keeps the whole default ruleset, so nothing is quietly switched off', () => {
    const config = read('.gitleaks.toml');

    expect(config).toMatch(/\[extend\]\s+useDefault = true/);
    expect(config).not.toMatch(/\[allowlist\]|\[\[rules\]\]|disabledRules/);
  });
});

describe('secret-scan.sh', () => {
  it('fails, naming how to install the tool, when gitleaks is not there', () => {
    const bin = join(repo, 'bin');
    mkdirSync(bin);
    // Only git on the path: the script must notice gitleaks is gone rather than skip.
    const gitPath = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
    symlinkSync(gitPath, join(bin, 'git'));

    const { code, output } = scan('tree', { ...process.env, PATH: bin });

    expect(code).toBe(127);
    expect(output).toContain('gitleaks is not installed');
    expect(output).toContain('brew install gitleaks');
  });

  it('refuses a mode it does not know, rather than doing nothing and passing', () => {
    const { code, output } = scan('everything');

    expect(code).not.toBe(0);
    expect(output).toContain('usage');
  });

  it.skipIf(!hasGitleaks)('lets a clean change through', () => {
    writeFileSync(join(repo, 'notes.txt'), 'nothing secret here\n');
    git('add', 'notes.txt');

    expect(scan('staged').code).toBe(0);
  });

  it.skipIf(!hasGitleaks)('stops a commit that stages a token, and never prints the token', () => {
    writeFileSync(join(repo, 'config.txt'), `token = ${FAKE_TOKEN}\n`);
    git('add', 'config.txt');

    const { code, output } = scan('staged');

    expect(code).not.toBe(0);
    expect(output).toContain('leaks found');
    expect(output).not.toContain(FAKE_TOKEN);
  });

  it.skipIf(!hasGitleaks)(
    'stops a push whose history holds a token, even once it was removed',
    () => {
      writeFileSync(join(repo, 'config.txt'), `token = ${FAKE_TOKEN}\n`);
      git('add', 'config.txt');
      git('commit', '--quiet', '--no-verify', '-m', 'add config');
      writeFileSync(join(repo, 'config.txt'), 'token = removed\n');
      git('commit', '--quiet', '--no-verify', '-am', 'remove the token');

      expect(scan('history').code).not.toBe(0);
    }
  );

  it.skipIf(!hasGitleaks)('finds a token in a file that was never added to git', () => {
    mkdirSync(join(repo, 'nested'));
    writeFileSync(join(repo, 'nested', 'scratch.env'), `GITHUB=${FAKE_TOKEN}\n`);

    expect(scan('tree').code).not.toBe(0);
  });

  it('starts with a shell shebang, so the hooks can run it with sh', () => {
    expect(read('scripts/secret-scan.sh').startsWith('#!/bin/sh')).toBe(true);
  });
});
