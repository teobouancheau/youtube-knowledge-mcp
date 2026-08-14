import type { BrainChunk, BrainVideoState } from '../brain-schemas.js';
import { chunkTranscript } from './brain-chunks.js';
import { throwIfAborted } from './context.js';
import { asYouTubeError } from './errors.js';
import { countWords } from './transcript.js';
import { getChapters, getTranscript, getVideoInfo, type VideoListItem } from './youtube.js';

/**
 * Reading one video into passages.
 *
 * Nothing here throws for anything to do with the video itself. A channel with
 * a members-only upload, a live stream still processing, or an episode nobody
 * captioned is still a channel worth having a brain for; which videos those
 * were belongs in the manifest, not in an exception that loses the other two
 * hundred.
 */

/**
 * A transcript that chunks past this is not a transcript. Recording the video
 * as failed keeps the brain buildable; letting it through does not.
 */
export const MAX_CHUNKS_PER_VIDEO = 2000;
export const MAX_CHUNKS_PER_BRAIN = 100_000;

/** Recorded against a video the size guards refused, alongside yt-dlp's own codes. */
export const TOO_LARGE = 'TOO_LARGE';
export const BRAIN_FULL = 'BRAIN_FULL';

export interface IngestResult {
  state: BrainVideoState;
  chunks: BrainChunk[];
}

export async function ingestVideo(
  video: VideoListItem,
  chunksSoFar: number
): Promise<IngestResult> {
  const base = { ...pendingState(video), uploadDate: await uploadDateOf(video) };

  try {
    const transcript = await getTranscript(video.id);
    // Most videos have no chapters, which is not a failure worth reporting.
    const chapters = await getChapters(video.id).catch(() => []);

    const chunks = chunkTranscript({
      videoId: video.id,
      title: video.title,
      segments: transcript.segments,
      chapters,
    });

    if (chunks.length > MAX_CHUNKS_PER_VIDEO) return refused(base, TOO_LARGE);
    if (chunksSoFar + chunks.length > MAX_CHUNKS_PER_BRAIN) return refused(base, BRAIN_FULL);

    return {
      state: {
        ...base,
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
          ? { ...base, state: 'no-captions' }
          : { ...base, state: 'failed', error: failure.code },
      chunks: [],
    };
  }
}

/**
 * When the video was published.
 *
 * A channel listing is fetched flat, which is what makes listing a thousand
 * videos one request rather than a thousand — and flat entries carry no upload
 * date. Asking for the video's own metadata is the only way to get one, so it
 * happens here, once per video actually read, and only when the listing did not
 * already supply it.
 *
 * Best effort: a channel whose dates cannot be read still gets a brain, and the
 * statistics say plainly that no dates were reported rather than inventing any.
 */
export async function uploadDateOf(video: VideoListItem): Promise<string> {
  if (video.uploadDate !== '') return video.uploadDate;

  try {
    return (await getVideoInfo(video.id)).uploadDate;
  } catch {
    return '';
  }
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

function refused(base: BrainVideoState, reason: string): IngestResult {
  return { state: { ...base, state: 'failed', error: reason }, chunks: [] };
}
