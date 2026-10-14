/** Time in the units the tools speak (seconds) and the units ffmpeg and whisper.cpp write (milliseconds). */

export const MILLISECONDS_PER_SECOND = 1000;

/** Seconds rounded to the nearest millisecond, which is all the precision any source here has. */
export function roundToMillisecond(seconds: number): number {
  return Math.round(seconds * MILLISECONDS_PER_SECOND) / MILLISECONDS_PER_SECOND;
}
