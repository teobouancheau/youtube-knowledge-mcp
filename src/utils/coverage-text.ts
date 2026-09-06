import type { Coverage } from '../harvest-schemas.js';

/**
 * The human- and model-readable form of a receipt.
 *
 * `structuredContent` carries the machine-readable truth, but a model reads
 * the text block, and that is where an overclaim actually happens. So every
 * extraction tool prepends this, from one function, rather than each writing
 * its own wording and drifting.
 *
 * The incomplete form says three things on purpose: the numbers, why it
 * stopped, and an explicit instruction not to describe it as everything. The
 * last one reads as belt-and-braces next to the `complete: false` field, and
 * it is: the field is for programs, the sentence is for the reader.
 */

const UNITS: Record<Coverage['scope'], string> = {
  'channel-catalog': 'videos',
  'video-details': 'videos',
  'video-comments': 'comments',
};

const WHY: Record<Coverage['reason'], string> = {
  COMPLETE: 'complete',
  CAP_REACHED: 'stopped by the requested cap',
  BUDGET_SPENT: 'stopped when the time budget ran out',
  RATE_LIMITED: 'stopped because YouTube throttled this client',
  CANCELLED: 'cancelled by the client',
  TIMEOUT: 'timed out',
  SOURCE_REFUSED: 'YouTube refused this content to the current session',
  COMMENTS_DISABLED: 'comments are turned off for this video',
  SOURCE_SILENT: 'YouTube states no total, so exhaustion cannot be proven',
  PARTIAL_ERROR: 'some items failed',
  NOT_ATTEMPTED: 'not attempted yet',
};

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function ratio(coverage: Coverage): string {
  if (coverage.expected === undefined || coverage.expected === 0) return '';
  const percent = (coverage.have / coverage.expected) * 100;
  return ` (${percent < 0.1 && percent > 0 ? '<0.1' : percent.toFixed(1)}%)`;
}

export function renderCoverage(coverage: Coverage): string {
  const unit = UNITS[coverage.scope];
  const of =
    coverage.expected === undefined
      ? `${count(coverage.have)} ${unit}`
      : `${count(coverage.have)} of ${coverage.expectedSource === 'youtube:comment_count' ? 'about ' : ''}${count(coverage.expected)} ${unit}${ratio(coverage)}`;

  const lines = [`Coverage: ${of} for ${coverage.targetId}.`];

  if (coverage.complete) {
    lines.push(`COMPLETE — ${WHY[coverage.reason]}, harvested ${coverage.harvestedAt}.`);
    if (coverage.staleAfter !== undefined) {
      lines.push(`Re-check after ${coverage.staleAfter} (this can change upstream).`);
    }
    return lines.join('\n');
  }

  const bias =
    coverage.sortApplied === 'top' && coverage.limitApplied !== undefined
      ? ', sorted by "top" (a biased prefix, not a random sample)'
      : '';

  lines.push(
    `INCOMPLETE — ${WHY[coverage.reason]}${bias}.`,
    `Do not describe this as the full ${unit === 'comments' ? 'comment history' : 'video list'}.`
  );
  if (coverage.note !== undefined) lines.push(coverage.note);

  return lines.join('\n');
}
