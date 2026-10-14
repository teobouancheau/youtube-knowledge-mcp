import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The commit-message rules, run through the real commitlint with the real configuration.
 *
 * What is checked is what a rule refuses, because a rule that refuses nothing looks exactly
 * like one that works. Each refusal below is a message someone would plausibly write.
 */

const ROOT = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf-8');

const lint = (message: string): { code: number; output: string } => {
  const result = spawnSync('npx', ['--no', '--', 'commitlint'], {
    cwd: ROOT,
    input: message,
    encoding: 'utf-8',
  });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
};

const GOOD = 'feat: add a thing\n\nWhy it exists, in a sentence that wraps well inside the limit.';

describe('what the commit-msg hook accepts', () => {
  it.each(['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore'])(
    'a %s commit with a body',
    (type) => {
      expect(lint(GOOD.replace('feat', type)).code).toBe(0);
    }
  );

  it('a header of exactly 72 characters', () => {
    const header = `fix: ${'x'.repeat(67)}`;

    expect(header).toHaveLength(72);
    expect(lint(header).code).toBe(0);
  });

  it('a body line of exactly 100 characters', () => {
    expect(lint(`${GOOD}\n${'y'.repeat(100)}`).code).toBe(0);
  });
});

describe('what the commit-msg hook refuses', () => {
  it.each([
    ['a type the project does not use', 'wip: half done', 'type must be one of'],
    ['no type at all', 'add a thing', 'type may not be empty'],
    ['a header over 72 characters', `fix: ${'x'.repeat(68)}`, 'header must not be longer'],
    [
      'a body line over 100 characters',
      `${GOOD}\n${'y'.repeat(101)}`,
      "body's lines must not be longer",
    ],
    [
      'a body with no blank line before it',
      'feat: add a thing\nthe body starts too soon',
      'blank line',
    ],
    ['a capitalised subject', 'feat: Add a thing', 'subject must not be'],
    ['a subject ending in a full stop', 'feat: add a thing.', 'subject may not end'],
  ])('%s', (_name, message, reason) => {
    const { code, output } = lint(message);

    expect(code).not.toBe(0);
    expect(output).toContain(reason);
  });

  it.each([
    ['a co-author trailer', 'Co-Authored-By: A Tool <noreply@example.com>'],
    ['the same trailer in other case', 'co-authored-by: A Tool <noreply@example.com>'],
    ['a "generated with" line', 'Generated with a tool'],
    ['a robot emoji', 'made by 🤖'],
  ])('%s anywhere in the message', (_name, line) => {
    const { code, output } = lint(`${GOOD}\n\n${line}`);

    expect(code).not.toBe(0);
    expect(output).toContain('attribution');
  });
});

describe('the hooks that carry the rules', () => {
  it('runs commitlint on the message of every commit', () => {
    expect(read('.husky/commit-msg').trim()).toBe('npx --no -- commitlint --edit "$1"');
  });

  it('starts the pre-push hook with the messages of the commits being pushed', () => {
    expect(read('.husky/pre-push').split('\n')[0]).toBe('sh scripts/commit-lint-range.sh');
  });
});

describe('scripts/commit-lint-range.sh', () => {
  let repo: string;

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
  const run = (): { code: number; output: string } => {
    const result = spawnSync('/bin/sh', [join(ROOT, 'scripts', 'commit-lint-range.sh')], {
      cwd: repo,
      encoding: 'utf-8',
    });
    return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
  };
  const commit = (message: string): void => {
    writeFileSync(join(repo, 'file.txt'), `${message}${String(Math.random())}`);
    git('add', 'file.txt');
    git('commit', '--quiet', '--no-verify', '-m', message);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'yk-commitlint-'));
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'commitlint.config.js'), read('commitlint.config.js'));
    // The configuration extends a shared preset, which has to resolve from the repository.
    symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
    commit('chore: an old commit the rules would not judge');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('fails, saying what to do, when the base it compares against is not known', () => {
    git('update-ref', '-d', 'refs/remotes/origin/main');

    const { code, output } = run();

    expect(code).toBe(1);
    expect(output).toContain('git fetch origin');
  });

  it('has nothing to judge when nothing is ahead of the base', () => {
    expect(run().code).toBe(0);
  });

  it('lets conforming commits ahead of the base through', () => {
    commit('feat: add one thing');
    commit('fix: repair another');

    expect(run().code).toBe(0);
  });

  it('stops a push that carries a commit the rules refuse, naming it', () => {
    commit('feat: add one thing');
    commit('WIP stuff');

    const { code, output } = run();

    expect(code).not.toBe(0);
    expect(output).toContain('WIP stuff');
  });

  it('does not re-judge a commit that is already on the base', () => {
    git('commit', '--quiet', '--no-verify', '--allow-empty', '--amend', '-m', 'old and messy');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    commit('feat: add one thing');

    expect(run().code).toBe(0);
  });
});
