import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatPreflightReport, runPreflight } from '../utils/preflight.js';
import { concurrencyState } from '../utils/ytdlp.js';
import { textContent } from '../utils/format.js';

export const healthCheckSchema = {};

/**
 * Diagnostics for the two external binaries everything here depends on.
 *
 * When yt-dlp is missing or stale every other tool fails in a way that looks
 * like "YouTube is broken"; this turns that into one readable answer.
 */
export async function healthCheckHandler(): Promise<CallToolResult> {
  const report = await runPreflight({ force: true });
  const { active, queued, limit } = concurrencyState();

  const lines = [
    formatPreflightReport(report),
    '',
    `yt-dlp concurrency: ${active}/${limit} active, ${queued} queued`,
  ];

  return textContent(lines.join('\n'));
}
