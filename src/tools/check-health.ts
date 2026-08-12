import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatPreflightReport, runPreflight } from '../utils/preflight.js';
import { concurrencyState } from '../utils/ytdlp.js';
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

  const lines = [
    formatPreflightReport(report),
    '',
    `yt-dlp concurrency: ${active}/${limit} active, ${queued} queued`,
  ];

  return toolResult(lines.join('\n'), {
    ok: report.ok,
    ytDlp: report.ytDlp,
    ffmpeg: report.ffmpeg,
    concurrency: { active, queued, limit },
  });
}
