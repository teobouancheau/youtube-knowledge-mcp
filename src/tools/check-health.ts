import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatPreflightReport, runPreflight } from '../utils/preflight.js';
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
};

/**
 * Diagnostics for the two external binaries everything here depends on.
 *
 * When yt-dlp is missing or stale every other tool fails in a way that looks
 * like "YouTube is broken"; this turns that into one readable answer.
 */
export async function checkHealthHandler(): Promise<CallToolResult> {
  const report = await runPreflight({ force: true });
  const { active, queued, limit } = concurrencyState();
  const session = readYtDlpEnv();

  const lines = [
    formatPreflightReport(report),
    '',
    `yt-dlp concurrency: ${active}/${limit} active, ${queued} queued`,
    describeYtDlpEnv(session),
  ];

  return toolResult(lines.join('\n'), {
    ok: report.ok,
    ytDlp: report.ytDlp,
    ffmpeg: report.ffmpeg,
    concurrency: { active, queued, limit },
    cookies: session.cookies,
    proxy: session.proxy,
  });
}
