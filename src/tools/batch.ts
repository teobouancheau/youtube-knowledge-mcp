import { z } from 'zod';
import { getChapters, getTranscript, getVideoInfo, listVideos } from '../utils/youtube.js';
import { textContent } from '../utils/format.js';
import { asYouTubeError } from '../utils/errors.js';
import { reportProgress, throwIfAborted } from '../utils/context.js';
import { formatTimestamp, segmentsToText, windowText } from '../utils/transcript.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Multi-video operations.
 *
 * Reading a playlist previously meant one round trip per video per fact — for a
 * 30-video playlist, ninety tool calls. These do the fan-out server-side, under
 * the shared yt-dlp concurrency limit, and report progress as they go.
 */

// -- get_transcripts -----------------------------------------------------

export const getTranscriptsSchema = {
  videos: z
    .array(z.string())
    .min(1)
    .max(25)
    .describe('Video IDs or URLs. Fetched under a shared concurrency limit.'),
  language: z.string().default('en').describe('Caption language. Default: en'),
  maxCharsPerVideo: z
    .number()
    .int()
    .min(200)
    .max(100_000)
    .default(4000)
    .describe(
      'Cap per transcript so a batch cannot flood the context. Use get_transcript for the full text of any one video. Default: 4000'
    ),
};

export async function getTranscriptsHandler({
  videos,
  language,
  maxCharsPerVideo,
}: {
  videos: string[];
  language: string;
  maxCharsPerVideo: number;
}): Promise<CallToolResult> {
  const sections: string[] = [];
  let succeeded = 0;

  for (const [index, video] of videos.entries()) {
    throwIfAborted();
    reportProgress(index, videos.length, `Fetching transcript ${index + 1} of ${videos.length}`);

    try {
      const result = await getTranscript(video, { language });
      const windowed = windowText(segmentsToText(result.segments), 0, maxCharsPerVideo);

      sections.push(
        [
          `## ${result.videoId} (${result.language})`,
          windowed.truncated
            ? `Truncated at ${maxCharsPerVideo.toLocaleString()} of ${windowed.totalChars.toLocaleString()} characters. Call get_transcript for the rest.`
            : undefined,
          '',
          windowed.text,
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n')
      );
      succeeded++;
    } catch (error) {
      // One unavailable video must not lose the other twenty-four.
      const failure = asYouTubeError(error);
      sections.push(`## ${video}\n[${failure.code}] ${failure.message}`);
    }
  }

  reportProgress(videos.length, videos.length);

  return textContent(
    [`${succeeded} of ${videos.length} transcripts retrieved`, '', ...sections].join('\n\n')
  );
}

// -- digest_playlist -----------------------------------------------------

export const digestPlaylistSchema = {
  url: z.string().describe('Playlist or channel URL'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('How many videos to inspect. Default: 10'),
  includeChapters: z
    .boolean()
    .default(true)
    .describe('Include chapter markers for each video. Default: true'),
  includeTranscriptStats: z
    .boolean()
    .default(false)
    .describe(
      'Fetch each transcript to report word counts and caption availability. Much slower. Default: false'
    ),
};

export async function digestPlaylistHandler({
  url,
  limit,
  includeChapters,
  includeTranscriptStats,
}: {
  url: string;
  limit: number;
  includeChapters: boolean;
  includeTranscriptStats: boolean;
}): Promise<CallToolResult> {
  const videos = await listVideos(url, limit);

  if (videos.length === 0) {
    return textContent('That playlist or channel has no videos.');
  }

  const sections: string[] = [];

  for (const [index, video] of videos.entries()) {
    throwIfAborted();
    reportProgress(index, videos.length, `Inspecting ${index + 1} of ${videos.length}`);

    const lines: string[] = [`### ${video.title}`, `${video.durationFormatted} · ${video.url}`];

    try {
      const info = await getVideoInfo(video.id);
      lines.push(`${info.viewCount.toLocaleString()} views · ${info.uploadDate}`);
    } catch {
      // Metadata is a nicety here; the listing already carries the essentials.
    }

    if (includeChapters) {
      try {
        const chapters = await getChapters(video.id);
        if (chapters.length > 0) {
          lines.push(
            `chapters: ${chapters
              .map((chapter) => `${formatTimestamp(chapter.startTime)} ${chapter.title}`)
              .join(' · ')}`
          );
        }
      } catch {
        // Not all videos have chapters, and that is not an error worth surfacing.
      }
    }

    if (includeTranscriptStats) {
      try {
        const transcript = await getTranscript(video.id);
        const words = segmentsToText(transcript.segments).split(/\s+/).filter(Boolean).length;
        lines.push(`transcript: ${words.toLocaleString()} words (${transcript.language})`);
      } catch (error) {
        lines.push(`transcript: unavailable (${asYouTubeError(error).code})`);
      }
    }

    sections.push(lines.join('\n'));
  }

  reportProgress(videos.length, videos.length);

  return textContent([`${videos.length} videos`, '', ...sections].join('\n\n'));
}
