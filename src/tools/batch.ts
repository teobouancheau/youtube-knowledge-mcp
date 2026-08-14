import { z } from 'zod';
import { getChapters, getTranscript, getVideoInfo, listVideos } from '../utils/youtube.js';
import { toolResult } from '../utils/format.js';
import { asYouTubeError } from '../utils/errors.js';
import { reportProgress, throwIfAborted } from '../utils/context.js';
import { countWords, formatTimestamp, segmentsToText, windowText } from '../utils/transcript.js';
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

export const getTranscriptsOutputSchema = {
  results: z.array(
    z.object({
      video: z.string(),
      videoId: z.string().optional(),
      language: z.string().optional(),
      text: z.string().optional(),
      truncated: z.boolean().optional(),
      totalChars: z.number().int().optional(),
      error: z.string().optional(),
    })
  ),
  requested: z.number().int(),
  succeeded: z.number().int(),
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
  const results: Record<string, unknown>[] = [];
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
      results.push({
        video,
        videoId: result.videoId,
        language: result.language,
        text: windowed.text,
        truncated: windowed.truncated,
        totalChars: windowed.totalChars,
      });
      succeeded++;
    } catch (error) {
      // One unavailable video must not lose the other twenty-four.
      const failure = asYouTubeError(error);
      sections.push(`## ${video}\n[${failure.code}] ${failure.message}`);
      results.push({ video, error: failure.code });
    }
  }

  reportProgress(videos.length, videos.length);

  return toolResult(
    [`${succeeded} of ${videos.length} transcripts retrieved`, '', ...sections].join('\n\n'),
    { results, requested: videos.length, succeeded }
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

export const digestPlaylistOutputSchema = {
  source: z.string(),
  videos: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      durationFormatted: z.string(),
      url: z.string(),
      viewCount: z.number().optional(),
      uploadDate: z.string().optional(),
      chapters: z.array(z.object({ title: z.string(), startSeconds: z.number() })).optional(),
      transcriptWords: z.number().int().optional(),
      transcriptError: z.string().optional(),
    })
  ),
  count: z.number().int(),
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
    return toolResult('That playlist or channel has no videos.', {
      source: url,
      videos: [],
      count: 0,
    });
  }

  const sections: string[] = [];
  const structuredVideos: Record<string, unknown>[] = [];

  for (const [index, video] of videos.entries()) {
    throwIfAborted();
    reportProgress(index, videos.length, `Inspecting ${index + 1} of ${videos.length}`);

    const lines: string[] = [`### ${video.title}`, `${video.durationFormatted} · ${video.url}`];
    const entry: Record<string, unknown> = {
      id: video.id,
      title: video.title,
      durationFormatted: video.durationFormatted,
      url: video.url,
    };

    try {
      const info = await getVideoInfo(video.id);
      lines.push(`${info.viewCount.toLocaleString()} views · ${info.uploadDate}`);
      entry.viewCount = info.viewCount;
      entry.uploadDate = info.uploadDate;
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
          entry.chapters = chapters.map((chapter) => ({
            title: chapter.title,
            startSeconds: chapter.startTime,
          }));
        }
      } catch {
        // Not all videos have chapters, and that is not an error worth surfacing.
      }
    }

    if (includeTranscriptStats) {
      try {
        const transcript = await getTranscript(video.id);
        const words = countWords(segmentsToText(transcript.segments));
        lines.push(`transcript: ${words.toLocaleString()} words (${transcript.language})`);
        entry.transcriptWords = words;
      } catch (error) {
        const failure = asYouTubeError(error);
        lines.push(`transcript: unavailable (${failure.code})`);
        entry.transcriptError = failure.code;
      }
    }

    sections.push(lines.join('\n'));
    structuredVideos.push(entry);
  }

  reportProgress(videos.length, videos.length);

  return toolResult([`${videos.length} videos`, '', ...sections].join('\n\n'), {
    source: url,
    videos: structuredVideos,
    count: videos.length,
  });
}
