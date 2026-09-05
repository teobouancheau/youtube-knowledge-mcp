import { YouTubeError } from './errors.js';
import { isRecord, parseYtDlpJson, runYtDlp } from './ytdlp.js';

/**
 * Ask yt-dlp which caption tracks the video actually has, so the error can name
 * the languages that would work instead of just saying "not found".
 */
export async function noCaptionsError(url: string, requested: string): Promise<YouTubeError> {
  let available: string[] = [];

  try {
    const stdout = await runYtDlp(['-j', '--skip-download', url], {
      label: 'get_transcript (caption probe)',
    });
    const data = parseYtDlpJson<{
      subtitles?: Record<string, unknown>;
      automatic_captions?: Record<string, unknown>;
    }>(stdout, isRecord, 'caption tracks');

    available = [
      ...Object.keys(data.subtitles ?? {}),
      ...Object.keys(data.automatic_captions ?? {}),
    ]
      .filter((code) => !code.endsWith('-orig'))
      .filter((code, index, all) => all.indexOf(code) === index)
      .sort();
  } catch {
    // The probe is a nicety; never let it mask the original problem.
  }

  if (available.length === 0) {
    return new YouTubeError('NO_CAPTIONS', 'This video has no captions in any language.', {
      nextStep:
        'Try get_video_info for the description, or get_comments for viewer discussion instead.',
    });
  }

  const shown = available.slice(0, 25).join(', ');
  const more = available.length > 25 ? `, and ${available.length - 25} more` : '';
  return new YouTubeError(
    'NO_CAPTIONS',
    `No "${requested}" captions are available for this video.`,
    { nextStep: `Call get_transcript again with one of: ${shown}${more}.` }
  );
}
