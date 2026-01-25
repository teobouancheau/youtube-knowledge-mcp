import { z } from 'zod';
import { listFormats, downloadVideo } from '../utils/youtube.js';

// Tool 1: List available formats
export const listFormatsSchema = {
  video: z.string().describe('YouTube video ID or URL'),
};

function formatFilesize(bytes?: number): string {
  if (!bytes) return 'Unknown';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

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

  return {
    content: [
      {
        type: 'text' as const,
        text: lines.join('\n'),
      },
    ],
  };
}

// Tool 2: Download video with selected format
export const downloadVideoSchema = {
  video: z.string().describe('YouTube video ID or URL'),
  formatId: z
    .string()
    .describe('Format code from list_formats (e.g., "22", "137+140" for video+audio merge)'),
  outputDir: z
    .string()
    .optional()
    .describe('Output directory (defaults to ~/.youtube-knowledge/downloads/)'),
};

export async function downloadVideoHandler({
  video,
  formatId,
  outputDir,
}: {
  video: string;
  formatId: string;
  outputDir?: string;
}) {
  const result = await downloadVideo(video, formatId, outputDir);

  const lines: string[] = [
    `✓ Downloaded`,
    '',
    result.title,
    `format ${result.format}`,
    '',
    result.filePath,
  ];

  return {
    content: [
      {
        type: 'text' as const,
        text: lines.join('\n'),
      },
    ],
  };
}
