import { execa } from 'execa';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { formatYouTubeDate } from './format.js';

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
  viewCount: number;
  likeCount: number;
  commentCount: number;
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

export interface VideoFormat {
  formatId: string;
  ext: string;
  resolution: string;
  fps?: number;
  vcodec: string;
  acodec: string;
  filesize?: number;
  note: string;
}

export interface DownloadResult {
  videoId: string;
  title: string;
  filePath: string;
  format: string;
}

export interface SearchResult {
  id: string;
  title: string;
  duration: number;
  durationFormatted: string;
  channel: string;
  viewCount: number;
  url: string;
}

export interface Chapter {
  title: string;
  startTime: number;
  startTimeFormatted: string;
  endTime: number;
  endTimeFormatted: string;
}

export interface VideoComment {
  author: string;
  text: string;
  likeCount: number;
  isPinned: boolean;
}

export interface ChannelInfo {
  name: string;
  channelId: string;
  handle: string;
  subscriberCount: number;
  channelUrl: string;
  description: string;
}

interface YtDlpSearchResult {
  id: string;
  title?: string;
  duration?: number;
  channel?: string;
  view_count?: number;
  url?: string;
}

interface YtDlpChapter {
  title: string;
  start_time: number;
  end_time: number;
}

interface YtDlpComment {
  author?: string;
  text?: string;
  like_count?: number;
  is_pinned?: boolean;
  parent?: string;
}

interface YtDlpChannelMeta {
  channel?: string;
  channel_id?: string;
  channel_url?: string;
  uploader_id?: string;
  channel_follower_count?: number;
  description?: string;
}

interface YtDlpChannelSearchResult {
  id?: string;
  title?: string;
  channel?: string;
  channel_id?: string;
  channel_url?: string;
  uploader_id?: string;
  channel_follower_count?: number;
  description?: string;
}

export interface PlaylistInfo {
  id: string;
  title: string;
  channel: string;
  handle: string;
  channelUrl: string;
  videoCount: number;
  lastModified: string;
  url: string;
  description: string;
}

interface YtDlpPlaylistMeta {
  id?: string;
  title?: string;
  channel?: string;
  channel_url?: string;
  uploader_id?: string;
  playlist_count?: number;
  modified_date?: string;
  webpage_url?: string;
  description?: string;
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
    '%(id)s|||%(title)s|||%(channel)s|||%(duration)s|||%(upload_date)s|||%(description)s|||%(tags)j|||%(thumbnail)s|||%(view_count)s|||%(like_count)s|||%(comment_count)s',
    url,
  ]);

  const [
    id,
    title,
    channel,
    durationStr,
    uploadDate,
    description,
    tagsJson,
    thumbnailUrl,
    viewCountStr,
    likeCountStr,
    commentCountStr,
  ] = stdout.split('|||');
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
    uploadDate: formatYouTubeDate(uploadDate),
    description: description || '',
    tags,
    url,
    thumbnailUrl: thumbnailUrl || '',
    viewCount: parseInt(viewCountStr, 10) || 0,
    likeCount: parseInt(likeCountStr, 10) || 0,
    commentCount: parseInt(commentCountStr, 10) || 0,
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
      uploadDate: formatYouTubeDate(uploadDate),
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
      `Failed to get transcript for ${videoId}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

const DOWNLOADS_DIR = join(homedir(), '.youtube-knowledge', 'downloads');

interface YtDlpFormat {
  format_id: string;
  ext: string;
  resolution?: string;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
  format_note?: string;
}

export async function listFormats(urlOrId: string): Promise<VideoFormat[]> {
  const videoId = extractVideoId(urlOrId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const { stdout } = await execa('yt-dlp', ['-j', '--skip-download', url]);

  const data = JSON.parse(stdout) as { formats?: YtDlpFormat[] };
  const formats = data.formats ?? [];

  return formats
    .filter((f) => !f.format_id.startsWith('sb')) // skip storyboards
    .map((f) => {
      const resolution =
        f.resolution ?? (f.width && f.height ? `${f.width}x${f.height}` : 'audio only');

      return {
        formatId: f.format_id,
        ext: f.ext,
        resolution,
        fps: f.fps,
        vcodec: f.vcodec ?? 'none',
        acodec: f.acodec ?? 'none',
        filesize: f.filesize ?? f.filesize_approx,
        note: f.format_note ?? '',
      };
    });
}

export type VideoQuality =
  'best' | '2160p' | '1440p' | '1080p' | '720p' | '480p' | '360p' | 'audio';

// Smart format selectors that use yt-dlp's fallback syntax
const QUALITY_FORMAT_SELECTORS: Record<VideoQuality, string> = {
  best: 'bestvideo*+bestaudio/best',
  '2160p':
    'bestvideo[height<=2160]+bestaudio/bestvideo*[height<=2160]+bestaudio/best[height<=2160]/bestvideo+bestaudio/best',
  '1440p':
    'bestvideo[height<=1440]+bestaudio/bestvideo*[height<=1440]+bestaudio/best[height<=1440]/bestvideo+bestaudio/best',
  '1080p':
    'bestvideo[height<=1080]+bestaudio/bestvideo*[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best',
  '720p':
    'bestvideo[height<=720]+bestaudio/bestvideo*[height<=720]+bestaudio/best[height<=720]/bestvideo+bestaudio/best',
  '480p':
    'bestvideo[height<=480]+bestaudio/bestvideo*[height<=480]+bestaudio/best[height<=480]/bestvideo+bestaudio/best',
  '360p':
    'bestvideo[height<=360]+bestaudio/bestvideo*[height<=360]+bestaudio/best[height<=360]/bestvideo+bestaudio/best',
  audio: 'bestaudio/best',
};

export async function downloadVideo(
  urlOrId: string,
  formatId: string,
  outputDir?: string,
  quality?: VideoQuality
): Promise<DownloadResult> {
  const videoId = extractVideoId(urlOrId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const targetDir = outputDir ?? DOWNLOADS_DIR;

  // Ensure download directory exists
  await mkdir(targetDir, { recursive: true });

  // Get video title first for the result
  const { stdout: titleOutput } = await execa('yt-dlp', [
    '--skip-download',
    '--print',
    '%(title)s',
    url,
  ]);
  const title = titleOutput.trim();

  // Download with specified format
  const outputTemplate = join(targetDir, '%(title)s.%(ext)s');

  // Determine format selector - use quality preset or explicit formatId
  const formatSelector = quality ? QUALITY_FORMAT_SELECTORS[quality] : formatId;

  // Build yt-dlp arguments with merge format for combining video+audio
  // -S vcodec:h264,acodec:m4a prefers H.264+AAC codecs compatible with MP4
  const ytdlpArgs = [
    '-f',
    formatSelector,
    '-S',
    'vcodec:h264,acodec:m4a',
    '-o',
    outputTemplate,
    '--no-playlist',
    '--merge-output-format',
    'mp4',
  ];

  // Try download, with fallback to best available if format fails
  try {
    await execa('yt-dlp', [...ytdlpArgs, url]);
  } catch (error) {
    // If specific format failed, try with best available as fallback
    if (!quality && formatId !== 'best') {
      console.error(`Format ${formatId} failed, trying best available...`);
      await execa('yt-dlp', [
        '-f',
        QUALITY_FORMAT_SELECTORS.best,
        '-S',
        'vcodec:h264,acodec:m4a',
        '-o',
        outputTemplate,
        '--no-playlist',
        '--merge-output-format',
        'mp4',
        url,
      ]);
    } else {
      throw error;
    }
  }

  // Get the actual filename that was created
  const { stdout: filenameOutput } = await execa('yt-dlp', [
    '-f',
    formatSelector,
    '--print',
    'filename',
    '-o',
    outputTemplate,
    '--no-playlist',
    '--merge-output-format',
    'mp4',
    url,
  ]);
  const filePath = filenameOutput.trim();

  return {
    videoId,
    title,
    filePath,
    format: quality ?? formatId,
  };
}

export async function searchVideos(query: string, limit = 5): Promise<SearchResult[]> {
  const { stdout } = await execa('yt-dlp', [
    `ytsearch${limit}:${query}`,
    '--dump-json',
    '--flat-playlist',
  ]);

  const lines = stdout.trim().split('\n').filter(Boolean);

  return lines.map((line) => {
    const data = JSON.parse(line) as YtDlpSearchResult;
    return {
      id: data.id,
      title: data.title ?? 'Unknown',
      duration: data.duration ?? 0,
      durationFormatted: formatDuration(data.duration ?? 0),
      channel: data.channel ?? 'Unknown',
      viewCount: data.view_count ?? 0,
      url: data.url ?? `https://www.youtube.com/watch?v=${data.id}`,
    };
  });
}

export async function getChapters(urlOrId: string): Promise<Chapter[]> {
  const videoId = extractVideoId(urlOrId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const { stdout } = await execa('yt-dlp', ['-j', '--skip-download', url]);
  const data = JSON.parse(stdout) as { chapters?: YtDlpChapter[] };
  const chapters = data.chapters ?? [];

  return chapters.map((ch) => ({
    title: ch.title,
    startTime: ch.start_time,
    startTimeFormatted: formatDuration(Math.floor(ch.start_time)),
    endTime: ch.end_time,
    endTimeFormatted: formatDuration(Math.floor(ch.end_time)),
  }));
}

export async function getComments(urlOrId: string, limit = 20): Promise<VideoComment[]> {
  const videoId = extractVideoId(urlOrId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const { stdout } = await execa('yt-dlp', [
    '-j',
    '--skip-download',
    '--write-comments',
    '--extractor-args',
    `youtube:comment_sort=top;max_comments=${limit}`,
    url,
  ]);

  const data = JSON.parse(stdout) as { comments?: YtDlpComment[] };
  const comments = data.comments ?? [];

  return comments
    .filter((c) => c.parent === 'root')
    .slice(0, limit)
    .map((c) => ({
      author: c.author ?? 'Unknown',
      text: c.text ?? '',
      likeCount: c.like_count ?? 0,
      isPinned: c.is_pinned ?? false,
    }));
}

export async function searchChannels(query: string, limit = 5): Promise<ChannelInfo[]> {
  // YouTube channel filter: sp=EgIQAg%3D%3D
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%3D%3D`;

  const { stdout } = await execa('yt-dlp', [
    searchUrl,
    '--dump-json',
    '--flat-playlist',
    '--playlist-items',
    `1-${limit}`,
  ]);

  const lines = stdout.trim().split('\n').filter(Boolean);

  return lines.map((line) => {
    const data = JSON.parse(line) as YtDlpChannelSearchResult;
    return {
      name: data.channel ?? data.title ?? 'Unknown',
      channelId: data.channel_id ?? data.id ?? '',
      handle: data.uploader_id ?? '',
      subscriberCount: data.channel_follower_count ?? 0,
      channelUrl: data.channel_url ?? '',
      description: data.description ?? '',
    };
  });
}

export async function getPlaylistInfo(playlistUrl: string): Promise<PlaylistInfo> {
  const { stdout } = await execa('yt-dlp', [
    '--dump-single-json',
    '--flat-playlist',
    '--playlist-items',
    '0',
    playlistUrl,
  ]);

  const data = JSON.parse(stdout) as YtDlpPlaylistMeta;
  const modDate = data.modified_date ?? '';

  return {
    id: data.id ?? '',
    title: data.title ?? 'Unknown',
    channel: data.channel ?? '',
    handle: data.uploader_id ?? '',
    channelUrl: data.channel_url ?? '',
    videoCount: data.playlist_count ?? 0,
    lastModified: formatYouTubeDate(modDate),
    url: data.webpage_url ?? playlistUrl,
    description: data.description ?? '',
  };
}

export async function getChannelInfo(channel: string): Promise<ChannelInfo> {
  const channelUrl = channel.startsWith('http')
    ? channel
    : `https://www.youtube.com/${channel.startsWith('@') ? channel : `@${channel}`}`;

  const { stdout } = await execa('yt-dlp', [
    '--dump-single-json',
    '--flat-playlist',
    '--playlist-items',
    '0',
    channelUrl,
  ]);

  const data = JSON.parse(stdout) as YtDlpChannelMeta;

  return {
    name: data.channel ?? 'Unknown',
    channelId: data.channel_id ?? '',
    handle: data.uploader_id ?? '',
    subscriberCount: data.channel_follower_count ?? 0,
    channelUrl: data.channel_url ?? channelUrl,
    description: data.description ?? '',
  };
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
