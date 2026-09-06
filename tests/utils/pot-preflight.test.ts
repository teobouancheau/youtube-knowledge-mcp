import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn(), ExecaError: class extends Error {} }));

import { execa } from 'execa';
import {
  parseImpersonateTargets,
  parseProviderList,
  resetSessionPreflightCache,
  runSessionPreflight,
  splitTopLevel,
} from '../../src/utils/pot-preflight.js';

const mockedExeca = vi.mocked(execa);

/**
 * Captured verbatim from yt-dlp 2026.08.19 on 2026-09-06, before and after a
 * provider plugin was installed. Parsing is only worth testing against strings
 * the tool actually emits.
 */
const POT_NONE = '[debug] [youtube] [pot] PO Token Providers: none';
const POT_INSTALLED =
  '[debug] [youtube] [pot] PO Token Providers: bgutil:http-1.3.2 (external), ' +
  'bgutil:script-node-1.3.2 (external, unavailable), bgutil:script-deno-1.3.2 (external)';
const JSC_LINE =
  '[debug] [youtube] [jsc] JS Challenge Providers: bun (unavailable), deno, ' +
  'node (unavailable), quickjs (unavailable)';

const IMPERSONATE_UNAVAILABLE = `[info] Available impersonate targets
Client    OS   Source
--------------------------------------------
Tor       -    curl_cffi>=0.11 (unavailable)
Chrome    -    curl_cffi (unavailable)`;

const IMPERSONATE_AVAILABLE = `[info] Available impersonate targets
Client          OS           Source
--------------------------------------
Chrome-133      Macos-15     curl_cffi
Safari-18.4     Ios-18.4     curl_cffi
Edge            -            curl_cffi`;

function respond(session: string, impersonate = ''): void {
  // `as never` matches tests/utils/preflight.test.ts: execa's overloads are
  // deep enough that a structural annotation sends the type checker into a
  // stack overflow inside no-unnecessary-type-assertion.
  mockedExeca.mockImplementation(((_command: string, args: readonly string[]) =>
    Promise.resolve(
      args.includes('--list-impersonate-targets')
        ? { stdout: impersonate, stderr: '' }
        : { stdout: '', stderr: session }
    )) as never);
}

beforeEach(() => {
  resetSessionPreflightCache();
  mockedExeca.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('splitTopLevel', () => {
  it('does not split the comma inside a parenthesised flag list', () => {
    // A plain split(',') tears "bgutil:http (external, unavailable)" in half
    // and loses the flag that decides whether the provider is usable.
    expect(splitTopLevel('a (external, unavailable), b')).toEqual([
      'a (external, unavailable)',
      'b',
    ]);
  });

  it('drops empty segments and tolerates unbalanced parentheses', () => {
    expect(splitTopLevel('a, , b')).toEqual(['a', 'b']);
    expect(splitTopLevel('a), b')).toEqual(['a)', 'b']);
  });
});

describe('parseProviderList', () => {
  it('treats "none" as no providers rather than one named none', () => {
    expect(parseProviderList('none')).toEqual([]);
    expect(parseProviderList('NONE')).toEqual([]);
    expect(parseProviderList('   ')).toEqual([]);
  });

  it('reads availability from the flags, not from presence', () => {
    const parsed = parseProviderList(
      'bgutil:http-1.3.2 (external), bgutil:script-node-1.3.2 (external, unavailable)'
    );
    expect(parsed).toEqual([
      { name: 'bgutil:http-1.3.2', available: true, flags: ['external'] },
      { name: 'bgutil:script-node-1.3.2', available: false, flags: ['external', 'unavailable'] },
    ]);
  });

  it('treats an unflagged entry as available', () => {
    expect(parseProviderList('deno')).toEqual([{ name: 'deno', available: true, flags: [] }]);
  });
});

describe('parseImpersonateTargets', () => {
  it('returns nothing when every target is unavailable', () => {
    // Passing --impersonate to a build without curl_cffi fails every spawn,
    // so an unavailable target must never be reported as usable.
    expect(parseImpersonateTargets(IMPERSONATE_UNAVAILABLE)).toEqual([]);
  });

  it('ignores rows with no client column', () => {
    // A separator or stray blank-ish row must not become a target named ''.
    expect(parseImpersonateTargets('[info] Available impersonate targets\n   \n\t\n')).toEqual([]);
  });

  it('pairs client with OS, and omits a placeholder OS', () => {
    expect(parseImpersonateTargets(IMPERSONATE_AVAILABLE)).toEqual([
      'Chrome-133:Macos-15',
      'Safari-18.4:Ios-18.4',
      'Edge',
    ]);
  });
});

describe('runSessionPreflight', () => {
  it('reports potAvailable false when yt-dlp has no provider', async () => {
    respond(`${POT_NONE}\n${JSC_LINE}`);
    const report = await runSessionPreflight();

    expect(report.potAvailable).toBe(false);
    expect(report.potProviders).toEqual([]);
    expect(report.jsRuntimes.find((r) => r.name === 'deno')?.available).toBe(true);
    expect(report.jsRuntimes.find((r) => r.name === 'node')?.available).toBe(false);
  });

  it('reports potAvailable true when at least one provider is usable', async () => {
    respond(`${POT_INSTALLED}\n${JSC_LINE}`, IMPERSONATE_AVAILABLE);
    const report = await runSessionPreflight();

    expect(report.potAvailable).toBe(true);
    expect(report.potProviders).toHaveLength(3);
    expect(report.impersonateTargets).toContain('Chrome-133:Macos-15');
  });

  it('reports potAvailable false when every provider is unavailable', async () => {
    respond('[debug] [youtube] [pot] PO Token Providers: bgutil:http (external, unavailable)');
    expect((await runSessionPreflight()).potAvailable).toBe(false);
  });

  it('caches a good report for the process lifetime', async () => {
    respond(`${POT_INSTALLED}\n${JSC_LINE}`);
    await runSessionPreflight();
    const calls = mockedExeca.mock.calls.length;

    await runSessionPreflight();
    expect(mockedExeca.mock.calls.length).toBe(calls);

    await runSessionPreflight({ force: true });
    expect(mockedExeca.mock.calls.length).toBeGreaterThan(calls);
  });

  it('re-probes a failed report once its short life expires', async () => {
    // A failed probe must not pin the diagnosis for the process lifetime; a
    // host under load can miss one spawn.
    mockedExeca.mockRejectedValue(new Error('ENOENT'));
    await runSessionPreflight();
    const failedCalls = mockedExeca.mock.calls.length;

    await runSessionPreflight();
    expect(mockedExeca.mock.calls.length).toBe(failedCalls);

    vi.setSystemTime(Date.now() + 61_000);
    respond(`${POT_INSTALLED}\n${JSC_LINE}`);
    expect((await runSessionPreflight()).potAvailable).toBe(true);
    vi.useRealTimers();
  });

  it('reports no impersonate targets when that probe fails', async () => {
    mockedExeca.mockImplementation(((_command: string, args: readonly string[]) =>
      args.includes('--list-impersonate-targets')
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve({ stdout: '', stderr: POT_INSTALLED })) as never);

    const report = await runSessionPreflight();
    expect(report.potAvailable).toBe(true);
    expect(report.impersonateTargets).toEqual([]);
  });

  it('marks the report as unknown, not empty, when the probe cannot run', async () => {
    mockedExeca.mockRejectedValue(new Error('ENOENT'));
    const report = await runSessionPreflight();

    expect(report.probeFailed).toBeDefined();
    expect(report.potAvailable).toBe(false);
  });

  it('survives output that contains neither debug line', async () => {
    respond('[debug] Encodings: locale UTF-8');
    const report = await runSessionPreflight();

    expect(report.potProviders).toEqual([]);
    expect(report.jsRuntimes).toEqual([]);
    expect(report.probeFailed).toBeUndefined();
  });
});
