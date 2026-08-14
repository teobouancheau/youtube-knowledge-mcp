import type { BrainChunk, BrainVideoState } from '../brain-schemas.js';
import { chunkTranscript } from './brain-chunks.js';
import { throwIfAborted } from './context.js';
import { asYouTubeError } from './errors.js';
import { countWords } from './transcript.js';
import { getTranscript, getVideoDetails, type VideoListItem } from './youtube.js';

/**
 * Reading one video into passages.
 *
 * Nothing here throws for anything to do with the video itself. A channel with
 * a members-only upload, a live stream still processing, or an episode nobody
 * captioned is still a channel worth having a brain for; which videos those
 * were belongs in the manifest, not in an exception that loses the other two
 * hundred.
 *
 * Metadata is read before the transcript, in that order deliberately: it is the
 * cheaper request, it carries the date and length the filters need, and a video
 * ruled out by them then costs one request instead of two.
 */

/**
 * A transcript that chunks past this is not a transcript. Recording the video
 * as failed keeps the brain buildable; letting it through does not.
 *
 * The brain-wide ceiling is what bounds memory, and it was chosen by measuring
 * rather than by feel: a corpus of 100,000 passages is 81MB on disk, and the
 * heaviest thing done to it — the phrase pass — peaked at 767MB of heap. Raising
 * it means measuring again.
 */
export const MAX_CHUNKS_PER_VIDEO = 2000;
export const MAX_CHUNKS_PER_BRAIN = 100_000;

/** Recorded against a video the size guards refused, alongside yt-dlp's own codes. */
export const TOO_LARGE = 'TOO_LARGE';
export const BRAIN_FULL = 'BRAIN_FULL';

export interface VideoFilters {
  /** Ignore anything published before this date (YYYY-MM-DD). */
  since?: string;
  /** Ignore anything shorter, to leave out shorts and clips. */
  minDurationSeconds: number;
}

export interface IngestOptions extends VideoFilters {
  language: string;
}

export interface IngestResult {
  state: BrainVideoState;
  chunks: BrainChunk[];
}

export async function ingestVideo(
  video: VideoListItem,
  chunksSoFar: number,
  options: IngestOptions
): Promise<IngestResult> {
  const listed = pendingState(video);

  try {
    // The listing is flat, which is what makes enumerating a thousand videos one
    // request rather than a thousand — and flat entries carry no date. These are
    // the real values, and the chapters come back in the same request.
    const details = await getVideoDetails(video.id);
    const known: BrainVideoState = {
      ...listed,
      uploadDate: details.uploadDate,
      durationSeconds: details.durationSeconds,
    };

    if (isExcluded(known, options) === true) return { state: excluded(known), chunks: [] };

    const transcript = await getTranscript(video.id, { language: options.language });
    const chunks = chunkTranscript({
      videoId: video.id,
      title: video.title,
      segments: transcript.segments,
      chapters: details.chapters,
    });

    if (chunks.length > MAX_CHUNKS_PER_VIDEO) return refused(known, TOO_LARGE);
    if (chunksSoFar + chunks.length > MAX_CHUNKS_PER_BRAIN) return refused(known, BRAIN_FULL);

    return {
      state: {
        ...known,
        state: 'indexed',
        chunkCount: chunks.length,
        wordCount: chunks.reduce((total, chunk) => total + countWords(chunk.text), 0),
      },
      chunks,
    };
  } catch (error) {
    // Cancellation is the client's decision, not this video's problem. Asking
    // the signal rather than classifying the error catches it however it was
    // raised — an aborted spawn, a rejected read, or the check between videos.
    throwIfAborted();

    const failure = asYouTubeError(error);

    return {
      state:
        failure.code === 'NO_CAPTIONS'
          ? { ...listed, state: 'no-captions' }
          : { ...listed, state: 'failed', error: failure.code },
      chunks: [],
    };
  }
}

/**
 * Whether the filters rule this video out, or `undefined` when its recorded
 * state cannot say.
 *
 * A build asks this of the manifest before deciding what to read, which is what
 * lets a changed filter take effect without re-fetching anything: once a video
 * has been looked at, its real date and length are on disk and the question is
 * answerable from there. `undefined` is the honest answer for a video only ever
 * seen in a flat listing — not a licence to assume it qualifies.
 */
export function isExcluded(state: BrainVideoState, filters: VideoFilters): boolean | undefined {
  const { since, minDurationSeconds } = filters;
  let undecided = false;

  if (minDurationSeconds > 0) {
    if (state.durationSeconds <= 0) undecided = true;
    else if (state.durationSeconds < minDurationSeconds) return true;
  }

  if (since !== undefined) {
    if (state.uploadDate === '') undecided = true;
    else if (state.uploadDate < since) return true;
  }

  return undecided ? undefined : false;
}

export function pendingState(video: VideoListItem): BrainVideoState {
  return {
    videoId: video.id,
    title: video.title,
    url: video.url,
    uploadDate: video.uploadDate,
    durationSeconds: video.duration,
    state: 'pending',
    chunkCount: 0,
    wordCount: 0,
  };
}

export function excluded(state: BrainVideoState): BrainVideoState {
  return { ...state, state: 'excluded', chunkCount: 0, wordCount: 0 };
}

function refused(state: BrainVideoState, reason: string): IngestResult {
  return { state: { ...state, state: 'failed', error: reason }, chunks: [] };
}
