import { YouTubeError } from './errors.js';
import { runYtDlp } from './ytdlp.js';

/**
 * Handing a video's stream to ffmpeg without downloading the file.
 *
 * Every tool that looks at pixels (a still, a contact sheet, scene cuts) needs the
 * same two guarantees, so they live in one place: the media URL really is an https
 * URL, and ffmpeg is told it may open nothing else.
 */

/** Up to 1080p: enough to read small text in a still. */
export const DETAIL_STREAM_SELECTOR = 'bestvideo[height<=1080]/best';
/** Up to 720p: plenty for frames shrunk to fit a model's context. */
export const PREVIEW_STREAM_SELECTOR = 'bestvideo[height<=720]/best[height<=720]/best';
/** The lightest stream that still shows a cut: scene detection reads every frame. */
export const SCAN_STREAM_SELECTOR = 'bestvideo[height<=360]/worst';

/**
 * ffmpeg accepts file:, pipe:, concat: and more as inputs. The only thing yt-dlp
 * should have resolved is an https media URL, and this allowlist makes ffmpeg refuse
 * anything else even if it had. A per-input option, so it must precede `-i`.
 */
export const FFMPEG_NETWORK_INPUT_ARGS = ['-protocol_whitelist', 'https,tls,tcp,crypto'];

export async function resolveStreamUrl(
  videoId: string,
  selector: string,
  label: string
): Promise<string> {
  const mediaUrl = (
    await runYtDlp(['-f', selector, '--get-url', '--no-playlist'], {
      label: `${label} (resolve)`,
      target: `https://www.youtube.com/watch?v=${videoId}`,
    })
  )
    .trim()
    .split('\n')[0];

  if (!mediaUrl?.startsWith('https://')) {
    throw new YouTubeError('YTDLP_FAILED', 'Could not resolve a video stream for this video.', {
      nextStep: 'Check the video is playable, or call check_health.',
    });
  }

  return mediaUrl;
}
