import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatPreflightReport, runPreflight } from '../utils/preflight.js';
import { runSessionPreflight } from '../utils/pot-preflight.js';
import { readStoreHealth, storeFailsHealth } from '../utils/store-health.js';
import { pacerState } from '../utils/ytdlp-pacer.js';
import { concurrencyState } from '../utils/ytdlp.js';
import { describeYtDlpEnv, readYtDlpEnv } from '../utils/ytdlp-env.js';
import { toolResult } from '../utils/format.js';
import { z } from 'zod';
import { binaryStatusSchema } from '../schemas.js';

export const checkHealthSchema = {};

export const checkHealthOutputSchema = {
  ok: z.boolean(),
  ytDlp: binaryStatusSchema,
  ffmpeg: binaryStatusSchema,
  concurrency: z.object({
    active: z.number().int(),
    queued: z.number().int(),
    limit: z.number().int().describe('The level in force now, which throttling can lower'),
    ceiling: z.number().int().describe('The configured maximum the level never exceeds'),
    cooldownMs: z.number().int().describe('How long new spawns are being held back'),
    circuitOpen: z.boolean().describe('True when repeated refusals have paused requests entirely'),
  }),
  cookies: z
    .enum(['file', 'browser', 'none'])
    .describe('Which kind of yt-dlp cookies are configured; never the value'),
  proxy: z.boolean().describe('Whether yt-dlp is configured to use a proxy'),
  session: z
    .object({
      potProviders: z.array(z.string()).describe('Usable PO token providers yt-dlp reports'),
      jsRuntimes: z.array(z.string()).describe('Usable JS challenge runtimes yt-dlp reports'),
      impersonateTargets: z.array(z.string()).describe('Usable --impersonate targets'),
      probeFailed: z.string().optional(),
    })
    .describe(
      'What yt-dlp can prove about its own session capabilities. Reported, never used to ' +
        'fail `ok`: a missing PO token provider does not predict a blocked player plane, ' +
        'and a health check that cries wolf gets ignored.'
    ),
  store: z
    .object({
      enabled: z.boolean(),
      exists: z.boolean(),
      storeVersion: z.number().int().optional(),
      sizeBytes: z.number().int(),
      walBytes: z
        .number()
        .int()
        .describe('A -wal file that never shrinks means a reader is pinning it'),
      integrity: z.enum(['ok', 'failed', 'unchecked']),
      channels: z.number().int(),
      videos: z.number().int(),
      comments: z.number().int(),
      error: z.string().optional(),
    })
    .describe(
      'The harvested store. A missing store does not fail `ok` — a fresh install has none. ' +
        'A failed integrity check, or a version this build does not understand, does.'
    ),
};

/**
 * Diagnostics for the two external binaries everything here depends on.
 *
 * When yt-dlp is missing or stale every other tool fails in a way that looks
 * like "YouTube is broken"; this turns that into one readable answer.
 */
export async function checkHealthHandler(): Promise<CallToolResult> {
  const [report, capabilities, store] = await Promise.all([
    runPreflight({ force: true }),
    runSessionPreflight(),
    readStoreHealth(),
  ]);
  const { active, queued, limit, ceiling } = concurrencyState();
  const pacer = pacerState();
  const session = readYtDlpEnv();

  const available = (entries: { name: string; available: boolean }[]): string[] =>
    entries.filter((entry) => entry.available).map((entry) => entry.name);
  const potProviders = available(capabilities.potProviders);
  const jsRuntimes = available(capabilities.jsRuntimes);

  const lines = [
    formatPreflightReport(report),
    '',
    `yt-dlp concurrency: ${String(active)}/${String(limit)} active, ${String(queued)} queued` +
      (pacer.circuitOpen
        ? ' — requests paused after repeated refusals'
        : pacer.cooldownMs > 0
          ? ` — cooling down for ${String(Math.ceil(pacer.cooldownMs / 1000))}s`
          : ''),
    describeYtDlpEnv(session),
    `PO token providers: ${potProviders.length > 0 ? potProviders.join(', ') : 'none'}`,
    `Impersonate targets: ${
      capabilities.impersonateTargets.length > 0
        ? `${String(capabilities.impersonateTargets.length)} available`
        : 'none (install curl_cffi into yt-dlp to enable --impersonate)'
    }`,
    store.exists
      ? `Store: ${String(store.videos)} videos, ${String(store.comments)} comments, integrity ${store.integrity}`
      : 'Store: empty (nothing harvested yet)',
  ];

  return toolResult(lines.join('\n'), {
    ok: report.ok && !storeFailsHealth(store),
    ytDlp: report.ytDlp,
    ffmpeg: report.ffmpeg,
    concurrency: {
      active,
      queued,
      limit,
      ceiling,
      cooldownMs: pacer.cooldownMs,
      circuitOpen: pacer.circuitOpen,
    },
    cookies: session.cookies,
    proxy: session.proxy,
    session: {
      potProviders,
      jsRuntimes,
      impersonateTargets: capabilities.impersonateTargets,
      ...(capabilities.probeFailed === undefined ? {} : { probeFailed: capabilities.probeFailed }),
    },
    store: {
      enabled: store.enabled,
      exists: store.exists,
      ...(store.storeVersion === undefined ? {} : { storeVersion: store.storeVersion }),
      sizeBytes: store.sizeBytes,
      walBytes: store.walBytes,
      integrity: store.integrity,
      channels: store.channels,
      videos: store.videos,
      comments: store.comments,
      ...(store.error === undefined ? {} : { error: store.error }),
    },
  });
}
