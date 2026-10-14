/**
 * The moments of a video people replay most.
 *
 * YouTube's heatmap is a hundred or so equal slices, each scored from 0 to 1. A
 * spike spans several adjacent slices, so taking the highest-scoring slices would
 * return one spike over and over; instead each moment reserves the slices around it.
 */

export interface HeatSegment {
  startSeconds: number;
  endSeconds: number;
  value: number;
}

/** A moment keeps this many slice-widths clear on either side of it. */
const SPACING_IN_SEGMENTS = 3;

function isClearOf(segment: HeatSegment, chosen: HeatSegment[]): boolean {
  const reach = SPACING_IN_SEGMENTS * (segment.endSeconds - segment.startSeconds);
  return chosen.every((peak) => Math.abs(segment.startSeconds - peak.startSeconds) >= reach);
}

/** Up to `count` distinct moments, strongest first. */
export function mostReplayed(heatmap: HeatSegment[], count: number): HeatSegment[] {
  const chosen: HeatSegment[] = [];

  for (const segment of [...heatmap].sort((a, b) => b.value - a.value)) {
    if (chosen.length >= count) break;
    if (isClearOf(segment, chosen)) chosen.push(segment);
  }

  return chosen;
}
