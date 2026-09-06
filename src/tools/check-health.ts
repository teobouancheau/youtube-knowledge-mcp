import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatPreflightReport, runPreflight } from '../utils/preflight.js';
import { runSessionPreflight } from '../utils/pot-preflight.js';
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
    limit: z.number().int(),
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
};

/**
 * Diagnostics for the two external binaries everything here depends on.
 *
 * When yt-dlp is missing or stale every other tool fails in a way that looks
 * like "YouTube is broken"; this turns that into one readable answer.
 */
export async function checkHealthHandler(): Promise<CallToolResult> {
  const [report, capabilities] = await Promise.all([
    runPreflight({ force: true }),
    runSessionPreflight(),
  ]);
  const { active, queued, limit } = concurrencyState();
  const session = readYtDlpEnv();

  const available = (entries: { name: string; available: boolean }[]): string[] =>
    entries.filter((entry) => entry.available).map((entry) => entry.name);
  const potProviders = available(capabilities.potProviders);
  const jsRuntimes = available(capabilities.jsRuntimes);

  const lines = [
    formatPreflightReport(report),
    '',
    `yt-dlp concurrency: ${active}/${limit} active, ${queued} queued`,
    describeYtDlpEnv(session),
    `PO token providers: ${potProviders.length > 0 ? potProviders.join(', ') : 'none'}`,
    `Impersonate targets: ${
      capabilities.impersonateTargets.length > 0
        ? `${String(capabilities.impersonateTargets.length)} available`
        : 'none (install curl_cffi into yt-dlp to enable --impersonate)'
    }`,
  ];

  return toolResult(lines.join('\n'), {
    ok: report.ok,
    ytDlp: report.ytDlp,
    ffmpeg: report.ffmpeg,
    concurrency: { active, queued, limit },
    cookies: session.cookies,
    proxy: session.proxy,
    session: {
      potProviders,
      jsRuntimes,
      impersonateTargets: capabilities.impersonateTargets,
      ...(capabilities.probeFailed === undefined ? {} : { probeFailed: capabilities.probeFailed }),
    },
  });
}
