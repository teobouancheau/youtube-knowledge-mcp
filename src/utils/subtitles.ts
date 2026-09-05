import type { TranscriptSegment } from './transcript.js';

/** Subtitle export: SRT and WebVTT for editors. */

/** 3723.5 -> "01:02:03,500" — the SRT wire format. */
export function formatSrtTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);

  const pad = (value: number, width = 2): string => value.toString().padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

export function toSrt(segments: TranscriptSegment[]): string {
  return (
    segments
      .map((segment, index) =>
        [
          index + 1,
          `${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(segment.end)}`,
          segment.text,
        ].join('\n')
      )
      .join('\n\n') + '\n'
  );
}

export function toVtt(segments: TranscriptSegment[]): string {
  const body = segments
    .map((segment) =>
      [
        `${formatSrtTimestamp(segment.start).replace(',', '.')} --> ${formatSrtTimestamp(segment.end).replace(',', '.')}`,
        segment.text,
      ].join('\n')
    )
    .join('\n\n');

  return `WEBVTT\n\n${body}\n`;
}
