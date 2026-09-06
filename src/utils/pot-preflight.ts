import { execa } from 'execa';

/**
 * Session preflight: what yt-dlp can prove about itself before we ask YouTube
 * anything.
 *
 * Measured on 2026-09-06: with no PO token provider installed, every *player*
 * request from this host failed with "Sign in to confirm you're not a bot",
 * while flat listings were never affected. Rotating `player_client` across six
 * clients and waiting out a 15-minute cooldown both failed. The cause was not
 * rate limiting and not the address alone — `yt-dlp -v` reported
 * `PO Token Providers: none`, so every player request went out without the
 * integrity token a browser attaches.
 *
 * That diagnosis is only useful if the server can see it, so this module reads
 * it out of yt-dlp's own debug output rather than guessing. It is deliberately
 * provider-agnostic: it reports what yt-dlp says it has, and never looks for a
 * particular plugin by name.
 */

export interface ProviderStatus {
  name: string;
  available: boolean;
  /** Flags yt-dlp printed in parentheses, e.g. "external". */
  flags: string[];
}

export interface SessionReport {
  /** False when yt-dlp reports no usable PO token provider. */
  potAvailable: boolean;
  potProviders: ProviderStatus[];
  jsRuntimes: ProviderStatus[];
  impersonateTargets: string[];
  /** Set when the probe itself could not run; the report is then unknown, not empty. */
  probeFailed?: string;
}

const PROBE_TIMEOUT_MS = 30_000;
const FAILED_REPORT_TTL_MS = 60_000;

/**
 * The `[youtube] [pot]` and `[youtube] [jsc]` debug lines are emitted only when
 * the *video* extractor initialises. Measured 2026-09-06: `--version`,
 * `ytsearch0:` and a `--flat-playlist` channel walk all produce neither line —
 * the listing plane never touches either subsystem.
 *
 * So the probe uses a syntactically valid but nonexistent video id. yt-dlp
 * initialises the extractor, prints both lines, then fails the lookup. That
 * failure is expected and ignored: it costs one request, depends on no real
 * video continuing to exist, and needs no fixture to be kept up to date.
 */
const PROBE_VIDEO_URL = 'https://www.youtube.com/watch?v=00000000000';
const PROBE_ARGS = ['-v', '--simulate', '--skip-download', PROBE_VIDEO_URL];

const POT_LINE = /PO Token Providers:\s*(.+)$/;
const JSC_LINE = /JS Challenge Providers:\s*(.+)$/;

let cached: SessionReport | undefined;
let cachedAt = 0;

/**
 * Split on commas that separate entries, not the ones inside a parenthesised
 * flag list. yt-dlp prints `bgutil:http-1.3.2 (external, unavailable)` — a
 * plain `split(',')` tears that entry in half and loses the flag that matters.
 */
export function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Parses one `Providers: ...` payload. `none` is an empty list, not a provider. */
export function parseProviderList(payload: string): ProviderStatus[] {
  const trimmed = payload.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return [];

  return splitTopLevel(trimmed).map((entry) => {
    const match = /^(.*?)\s*\((.*)\)$/.exec(entry);
    if (match === null) return { name: entry, available: true, flags: [] };

    const flags = splitTopLevel(match[2] ?? '').map((flag) => flag.toLowerCase());
    return {
      name: (match[1] ?? '').trim(),
      available: !flags.includes('unavailable'),
      flags,
    };
  });
}

/**
 * Reads `yt-dlp --list-impersonate-targets`, keeping only rows that are
 * actually usable. Every target is unavailable without curl_cffi, and passing
 * `--impersonate` to a build that lacks it fails every spawn — so an
 * unavailable target must be visible here rather than discovered per request.
 */
export function parseImpersonateTargets(stdout: string): string[] {
  const targets: string[] = [];

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('[') || line.startsWith('-')) continue;
    if (line.toLowerCase().startsWith('client')) continue;
    if (line.toLowerCase().includes('(unavailable)')) continue;

    const columns = line.split(/\s{2,}/).filter((column) => column.length > 0);
    const client = columns[0]?.trim();
    if (client === undefined || client === '') continue;

    const os = columns[1]?.trim();
    targets.push(os === undefined || os === '' || os === '-' ? client : `${client}:${os}`);
  }

  return targets;
}

async function probe(args: string[]): Promise<{ stdout: string; stderr: string } | undefined> {
  try {
    // yt-dlp writes debug lines to stderr and exits non-zero on some probes;
    // `reject: false` keeps both streams instead of throwing them away.
    const result = await execa('yt-dlp', args, { timeout: PROBE_TIMEOUT_MS, reject: false });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch {
    return undefined;
  }
}

function readProviders(output: string, pattern: RegExp): ProviderStatus[] {
  for (const line of output.split('\n')) {
    const match = pattern.exec(line);
    if (match !== null) return parseProviderList(match[1] ?? '');
  }
  return [];
}

export async function runSessionPreflight(
  options: { force?: boolean } = {}
): Promise<SessionReport> {
  // Mirrors runPreflight: a good answer holds for the process, a bad one gets a
  // short life so one slow spawn does not pin the diagnosis for good.
  if (cached !== undefined && !options.force) {
    if (cached.probeFailed === undefined || Date.now() - cachedAt < FAILED_REPORT_TTL_MS) {
      return cached;
    }
  }

  const [session, impersonate] = await Promise.all([
    probe(PROBE_ARGS),
    probe(['--list-impersonate-targets']),
  ]);

  if (session === undefined) {
    cached = {
      potAvailable: false,
      potProviders: [],
      jsRuntimes: [],
      impersonateTargets: [],
      probeFailed: 'yt-dlp could not be probed for session capabilities.',
    };
    cachedAt = Date.now();
    return cached;
  }

  const output = `${session.stderr}\n${session.stdout}`;
  const potProviders = readProviders(output, POT_LINE);

  cached = {
    potAvailable: potProviders.some((provider) => provider.available),
    potProviders,
    jsRuntimes: readProviders(output, JSC_LINE),
    impersonateTargets:
      impersonate === undefined
        ? []
        : parseImpersonateTargets(`${impersonate.stdout}\n${impersonate.stderr}`),
  };
  cachedAt = Date.now();
  return cached;
}

/** Test seam — the report is cached for the process lifetime in normal use. */
export function resetSessionPreflightCache(): void {
  cached = undefined;
  cachedAt = 0;
}
