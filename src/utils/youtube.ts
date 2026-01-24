import { execa } from 'execa';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

const CACHE_DIR = join(homedir(), '.youtube-knowledge', 'transcripts');

export interface VideoInfo {
  id: string;
  title: string;
  channel: string;
  duration: number;
  durationFormatted: string;
  uploadDate: string;
  description: string;
  tags: string[];
  url: string;
  thumbnailUrl: string;
}

export interface VideoListItem {
  id: string;
  title: string;
  duration: number;
  durationFormatted: string;
  uploadDate: string;
  url: string;
}

export interface TranscriptResult {
  transcript: string;
  language: string;
  videoId: string;
}

function extractVideoId(urlOrId: string): string {
  // If it's already an ID (11 characters, no special chars except - and _)
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) {
    return urlOrId;
  }

  // Try to extract from URL
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = urlOrId.match(pattern);
    if (match) {
      return match[1];
    }
  }

  throw new Error(`Could not extract video ID from: ${urlOrId}`);
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export async function getVideoInfo(urlOrId: string): Promise<VideoInfo> {
  const videoId = extractVideoId(urlOrId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const { stdout } = await execa('yt-dlp', [
    '--skip-download',
    '--print',
    '%(id)s|||%(title)s|||%(channel)s|||%(duration)s|||%(upload_date)s|||%(description)s|||%(tags)j|||%(thumbnail)s',
    url,
  ]);

  const [id, title, channel, durationStr, uploadDate, description, tagsJson, thumbnailUrl] =
    stdout.split('|||');
  const duration = parseInt(durationStr, 10) || 0;

  let tags: string[] = [];
  try {
    const parsedTags: unknown = JSON.parse(tagsJson || '[]');
    if (Array.isArray(parsedTags)) {
      tags = parsedTags.filter((t): t is string => typeof t === 'string');
    }
  } catch {
    tags = [];
  }

  return {
    id,
    title,
    channel,
    duration,
    durationFormatted: formatDuration(duration),
    uploadDate: uploadDate
      ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
      : '',
    description: description || '',
    tags,
    url,
    thumbnailUrl: thumbnailUrl || '',
  };
}

export async function listVideos(urlOrChannel: string, limit = 20): Promise<VideoListItem[]> {
  const { stdout } = await execa('yt-dlp', [
    '--skip-download',
    '--flat-playlist',
    '--print',
    '%(id)s|||%(title)s|||%(duration)s|||%(upload_date)s',
    '--playlist-end',
    limit.toString(),
    urlOrChannel,
  ]);

  const lines = stdout.trim().split('\n').filter(Boolean);

  return lines.map((line) => {
    const [id, title, durationStr, uploadDate] = line.split('|||');
    const duration = parseInt(durationStr, 10) || 0;

    return {
      id,
      title: title || 'Unknown title',
      duration,
      durationFormatted: formatDuration(duration),
      uploadDate: uploadDate
        ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
        : '',
      url: `https://www.youtube.com/watch?v=${id}`,
    };
  });
}

export async function getTranscript(
  urlOrId: string,
  preferredLang = 'en'
): Promise<TranscriptResult> {
  const videoId = extractVideoId(urlOrId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Ensure cache directory exists
  await mkdir(CACHE_DIR, { recursive: true });

  // Check cache first
  const cachedPath = join(CACHE_DIR, `${videoId}.txt`);
  if (existsSync(cachedPath)) {
    const transcript = await readFile(cachedPath, 'utf-8');
    return {
      transcript,
      language: preferredLang,
      videoId,
    };
  }

  // Use a temp directory for yt-dlp subtitle output
  const tempDir = join(CACHE_DIR, 'temp');
  await mkdir(tempDir, { recursive: true });
  const outputTemplate = join(tempDir, videoId);

  try {
    // Try to get subtitles (auto-generated or manual)
    await execa('yt-dlp', [
      '--skip-download',
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang',
      `${preferredLang},${preferredLang}-orig`,
      '--sub-format',
      'vtt',
      '--convert-subs',
      'vtt',
      '-o',
      outputTemplate,
      url,
    ]);

    // Find the generated subtitle file
    const possibleFiles = [
      `${outputTemplate}.${preferredLang}.vtt`,
      `${outputTemplate}.${preferredLang}-orig.vtt`,
      `${outputTemplate}.en.vtt`,
    ];

    let subtitleFile: string | null = null;
    let detectedLang = preferredLang;

    for (const file of possibleFiles) {
      if (existsSync(file)) {
        subtitleFile = file;
        if (file.includes('-orig')) {
          detectedLang = `${preferredLang} (auto-generated)`;
        }
        break;
      }
    }

    if (!subtitleFile) {
      throw new Error(`No subtitles found for video ${videoId}`);
    }

    // Read and parse VTT file
    const vttContent = await readFile(subtitleFile, 'utf-8');
    const transcript = parseVtt(vttContent);

    // Cache the transcript
    await writeFile(cachedPath, transcript, 'utf-8');

    // Clean up temp file (ignore errors)
    await unlink(subtitleFile).catch(() => undefined);

    return {
      transcript,
      language: detectedLang,
      videoId,
    };
  } catch (error) {
    throw new Error(
      `Failed to get transcript for ${videoId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseVtt(vttContent: string): string {
  const lines = vttContent.split('\n');
  const textLines: string[] = [];
  let lastText = '';

  for (const line of lines) {
    // Skip VTT headers and timestamps
    if (
      line.startsWith('WEBVTT') ||
      line.startsWith('Kind:') ||
      line.startsWith('Language:') ||
      line.includes('-->') ||
      /^\d{2}:\d{2}/.exec(line) ||
      line.trim() === ''
    ) {
      continue;
    }

    // Remove VTT tags like <c> </c>
    const cleanLine = line.replace(/<[^>]+>/g, '').trim();

    // Skip duplicate lines (common in auto-generated subs)
    if (cleanLine && cleanLine !== lastText) {
      textLines.push(cleanLine);
      lastText = cleanLine;
    }
  }

  return textLines.join(' ').replace(/\s+/g, ' ').trim();
}
