import { homedir } from 'os';
import { join } from 'path';
import { mkdir, readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { formatYouTubeDate } from './format.js';
import { YouTubeError } from './errors.js';
import { TIMEOUTS, isRecord, parseYtDlpJson, parseYtDlpJsonLines, runYtDlp } from './ytdlp.js';
import { assertLanguageTag, resolveOutputDir } from './validate.js';
import { log } from './context.js';

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

function isSearchResult(value: unknown): value is YtDlpSearchResult {
  return isRecord(value) && typeof value.id === 'string';
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

  const stdout = await runYtDlp(
    [
      '--skip-download',
      '--print',
      '%(id)s|||%(title)s|||%(channel)s|||%(duration)s|||%(upload_date)s|||%(description)s|||%(tags)j|||%(thumbnail)s|||%(view_count)s|||%(like_count)s|||%(comment_count)s',
      url,
    ],
    { label: 'get_video_info' }
  );

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
  const stdout = await runYtDlp(
    [
      '--skip-download',
      '--flat-playlist',
      '--print',
      '%(id)s|||%(title)s|||%(duration)s|||%(upload_date)s',
      '--playlist-end',
      limit.toString(),
      urlOrChannel,
    ],
    { label: 'fetch_videos', timeoutMs: TIMEOUTS.transcript }
  );

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
  assertLanguageTag(preferredLang);
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
    await runYtDlp(
      [
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
      ],
      { label: 'get_transcript', timeoutMs: TIMEOUTS.transcript }
    );

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
      throw await noCaptionsError(url, preferredLang);
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
    // Already typed and actionable — pass it through rather than flattening it
    // into a generic string, which is what the old wrapper did to every failure.
    if (error instanceof YouTubeError) throw error;
    throw new YouTubeError('YTDLP_FAILED', `Could not read the transcript for ${videoId}.`, {
      nextStep: 'Verify the video exists and has captions, or call health_check.',
      cause: error,
    });
  }
}

/**
 * Ask yt-dlp which caption tracks the video actually has, so the error can name
 * the languages that would work instead of just saying "not found".
 */
async function noCaptionsError(url: string, requested: string): Promise<YouTubeError> {
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

  const stdout = await runYtDlp(['-j', '--skip-download', url], { label: 'list_formats' });

  const data = parseYtDlpJson<{ formats?: YtDlpFormat[] }>(stdout, isRecord, 'video formats');
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
  const targetDir = resolveOutputDir(outputDir, DOWNLOADS_DIR);

  // Ensure download directory exists
  await mkdir(targetDir, { recursive: true });

  // Get video title first for the result
  const titleOutput = await runYtDlp(['--skip-download', '--print', '%(title)s', url], {
    label: 'download_video (title)',
  });
  const title = titleOutput.trim();

  // Download with specified format
  const outputTemplate = join(targetDir, '%(title)s.%(ext)s');

  // A quality preset always wins over formatId; that is what the tool schema
  // promises, and the two are resolved in exactly one place.
  const formatSelector = quality ? QUALITY_FORMAT_SELECTORS[quality] : formatId;

  // -S vcodec:h264,acodec:m4a prefers H.264+AAC, which merge cleanly into MP4.
  const commonArgs = (selector: string): string[] => [
    '-f',
    selector,
    '-S',
    'vcodec:h264,acodec:m4a',
    '-o',
    outputTemplate,
    '--no-playlist',
    '--merge-output-format',
    'mp4',
  ];

  // Transfers are not retried automatically: a partial file on disk plus a
  // silent second attempt is worse than one clear failure.
  const downloadOptions = {
    label: 'download_video',
    timeoutMs: TIMEOUTS.download,
    retry: false,
  } as const;

  let effectiveSelector = formatSelector;
  try {
    await runYtDlp([...commonArgs(formatSelector), url], downloadOptions);
  } catch (error) {
    // An explicitly requested format may simply not exist for this video, so
    // falling back to "best" is worth one attempt. A preset failing is not:
    // presets already encode their own fallback chain, and "best" failing
    // leaves nothing to fall back to.
    const alreadyBroadest = quality !== undefined || formatId === 'best';
    if (alreadyBroadest) throw error;

    log('warning', `format ${formatId} unavailable, falling back to best`);
    effectiveSelector = QUALITY_FORMAT_SELECTORS.best;
    await runYtDlp([...commonArgs(effectiveSelector), url], downloadOptions);
  }

  // Ask yt-dlp what it actually named the file rather than guessing.
  const filenameOutput = await runYtDlp(
    [...commonArgs(effectiveSelector), '--print', 'filename', '--skip-download', url],
    { label: 'download_video (filename)' }
  );

  return {
    videoId,
    title,
    filePath: filenameOutput.trim(),
    format: quality ?? formatId,
  };
}

export async function searchVideos(query: string, limit = 5): Promise<SearchResult[]> {
  const stdout = await runYtDlp([`ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist'], {
    label: 'search_videos',
  });

  return parseYtDlpJsonLines(stdout, isSearchResult).map((data) => {
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

  const stdout = await runYtDlp(['-j', '--skip-download', url], { label: 'get_chapters' });
  const data = parseYtDlpJson<{ chapters?: YtDlpChapter[] }>(stdout, isRecord, 'video chapters');
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

  const stdout = await runYtDlp(
    [
      '-j',
      '--skip-download',
      '--write-comments',
      '--extractor-args',
      `youtube:comment_sort=top;max_comments=${limit}`,
      url,
    ],
    { label: 'get_comments', timeoutMs: TIMEOUTS.comments }
  );

  const data = parseYtDlpJson<{ comments?: YtDlpComment[] }>(stdout, isRecord, 'video comments');
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

  const stdout = await runYtDlp(
    [searchUrl, '--dump-json', '--flat-playlist', '--playlist-items', `1-${limit}`],
    { label: 'search_channels' }
  );

  return parseYtDlpJsonLines<YtDlpChannelSearchResult>(stdout, isRecord).map((data) => {
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
  const stdout = await runYtDlp(
    ['--dump-single-json', '--flat-playlist', '--playlist-items', '0', playlistUrl],
    { label: 'get_playlist_info' }
  );

  const data = parseYtDlpJson<YtDlpPlaylistMeta>(stdout, isRecord, 'playlist metadata');
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

  const stdout = await runYtDlp(
    ['--dump-single-json', '--flat-playlist', '--playlist-items', '0', channelUrl],
    { label: 'get_channel_info' }
  );

  const data = parseYtDlpJson<YtDlpChannelMeta>(stdout, isRecord, 'channel metadata');

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
