import { z } from 'zod';
import { listFormats, downloadVideo, VideoQuality } from '../utils/youtube.js';
import { formatFilesize, textContent } from '../utils/format.js';

// Tool 1: List available formats
export const listFormatsSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
};

export async function listFormatsHandler({ video }: { video: string }) {
  const formats = await listFormats(video);

  const lines: string[] = [`${formats.length} formats available`, ''];

  const combined = formats.filter((f) => f.vcodec !== 'none' && f.acodec !== 'none');
  const videoOnly = formats.filter((f) => f.vcodec !== 'none' && f.acodec === 'none');
  const audioOnly = formats.filter((f) => f.vcodec === 'none' && f.acodec !== 'none');

  if (combined.length > 0) {
    lines.push('video + audio:');
    combined.forEach((f) => {
      const fps = f.fps ? ` ${f.fps}fps` : '';
      lines.push(
        `  ${f.formatId} · ${f.ext} · ${f.resolution}${fps} · ${formatFilesize(f.filesize)}`
      );
    });
  }

  if (videoOnly.length > 0) {
    lines.push('');
    lines.push('video only:');
    videoOnly.forEach((f) => {
      const fps = f.fps ? ` ${f.fps}fps` : '';
      lines.push(
        `  ${f.formatId} · ${f.ext} · ${f.resolution}${fps} · ${formatFilesize(f.filesize)}`
      );
    });
  }

  if (audioOnly.length > 0) {
    lines.push('');
    lines.push('audio only:');
    audioOnly.forEach((f) => {
      lines.push(`  ${f.formatId} · ${f.ext} · ${f.acodec} · ${formatFilesize(f.filesize)}`);
    });
  }

  if (combined.length === 0) {
    lines.push('');
    lines.push('tip: combine formats like "137+140" for video+audio');
  }

  return textContent(lines.join('\n'));
}

// Tool 2: Download video with selected format
export const downloadVideoSchema = {
  video: z.string().describe('YouTube video ID (e.g., dQw4w9WgXcQ) or full URL'),
  quality: z
    .enum(['best', '2160p', '1440p', '1080p', '720p', '480p', '360p', 'audio'])
    .optional()
    .describe(
      'Quality preset with smart fallback. "best" selects highest available. Specific resolutions fall back to next best if unavailable. "audio" extracts audio only. Default: best'
    ),
  formatId: z
    .string()
    .optional()
    .describe(
      'Specific format code from list_formats (e.g., "22", "137+140" for combined). Overrides quality when provided.'
    ),
  outputDir: z
    .string()
    .optional()
    .describe('Output directory path. Default: ~/.youtube-knowledge/downloads/'),
};

export async function downloadVideoHandler({
  video,
  quality,
  formatId,
  outputDir,
}: {
  video: string;
  quality?: VideoQuality;
  formatId?: string;
  outputDir?: string;
}) {
  // Use "best" as default quality if neither quality nor formatId is provided
  const effectiveQuality = quality ?? (formatId ? undefined : 'best');

  const result = await downloadVideo(video, formatId ?? 'best', outputDir, effectiveQuality);

  const qualityLabel = quality ? `quality: ${quality}` : `format: ${result.format}`;

  const lines: string[] = [`✓ Downloaded`, '', result.title, qualityLabel, '', result.filePath];

  return textContent(lines.join('\n'));
}
