import { defineTool, type ToolDefinition } from './types.js';
import {
  extractClipSchema,
  extractClipOutputSchema,
  extractClipHandler,
  extractAudioClipSchema,
  extractAudioClipOutputSchema,
  extractAudioClipHandler,
  extractClipsSchema,
  extractClipsOutputSchema,
  extractClipsHandler,
} from '../tools/clips.js';
import {
  downloadVideoSchema,
  downloadVideoOutputSchema,
  downloadVideoHandler,
} from '../tools/download-video.js';
import {
  extractGifSchema,
  extractGifOutputSchema,
  extractGifHandler,
  concatClipsSchema,
  concatClipsOutputSchema,
  concatClipsHandler,
} from '../tools/gif-concat.js';
import {
  extractFrameSchema,
  extractFrameOutputSchema,
  extractFrameHandler,
  exportSubtitlesSchema,
  exportSubtitlesOutputSchema,
  exportSubtitlesHandler,
} from '../tools/frames-subtitles.js';

/** Clips, stills, subtitles and downloads. Local only: these write files. */
export const mediaTools: ToolDefinition[] = [
  defineTool({
    name: 'extract_clip',
    mode: 'stdio',
    title: 'Extract a Video Clip',
    description:
      'Cut a time range out of a YouTube video without downloading the whole thing. Give start and end, or a chapter name. Pair with search_transcript to find the moment first. Requires ffmpeg.',
    inputSchema: extractClipSchema,
    outputSchema: extractClipOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: extractClipHandler,
  }),
  defineTool({
    name: 'extract_audio_clip',
    mode: 'stdio',
    title: 'Extract an Audio Clip',
    description:
      'Cut a time range out of a video as audio only, in an editor-friendly format (mp3, m4a, wav, flac, opus). Use for podcast pulls and voice-over sourcing. Requires ffmpeg.',
    inputSchema: extractAudioClipSchema,
    outputSchema: extractAudioClipOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: extractAudioClipHandler,
  }),
  defineTool({
    name: 'extract_clips',
    mode: 'stdio',
    title: 'Extract Several Clips',
    description:
      'Cut several time ranges out of one video in a single call. A range that fails is reported individually rather than losing the clips that succeeded. Requires ffmpeg.',
    inputSchema: extractClipsSchema,
    outputSchema: extractClipsOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: extractClipsHandler,
  }),
  defineTool({
    name: 'extract_frame',
    mode: 'stdio',
    title: 'Capture a Frame',
    description:
      'Capture a single still image from a video at a given timestamp, without downloading the file. Use for thumbnails and reference frames. Requires ffmpeg.',
    inputSchema: extractFrameSchema,
    outputSchema: extractFrameOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: extractFrameHandler,
  }),
  defineTool({
    name: 'extract_gif',
    mode: 'stdio',
    title: 'Make a GIF',
    description:
      'Make a short looping GIF from a moment of a video, without downloading the file. Give start and end, or a chapter name, up to 15 seconds. Use to share a reaction or a key moment. Requires ffmpeg.',
    inputSchema: extractGifSchema,
    outputSchema: extractGifOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: extractGifHandler,
  }),
  defineTool({
    name: 'concat_clips',
    mode: 'stdio',
    title: 'Join Clips Into One Video',
    description:
      'Join several video files into one, in the order given, re-encoded so clips from different moments or sources fit together. Pass the paths extract_clip returned. This is the last step of cutting a montage. Requires ffmpeg.',
    inputSchema: concatClipsSchema,
    outputSchema: concatClipsOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: concatClipsHandler,
  }),
  defineTool({
    name: 'export_subtitles',
    mode: 'stdio',
    title: 'Export Subtitles',
    description:
      'Write a video transcript to disk as SRT, WebVTT or plain text, ready to import into a video editor such as Premiere, Resolve or CapCut.',
    inputSchema: exportSubtitlesSchema,
    outputSchema: exportSubtitlesOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: exportSubtitlesHandler,
  }),
  defineTool({
    name: 'download_video',
    mode: 'stdio',
    title: 'Download YouTube Video',
    description:
      'Download a YouTube video to local disk. Use the quality parameter for automatic format selection with smart fallbacks, or formatId for a specific format from list_formats. Returns the downloaded file path, title, and format details.',
    inputSchema: downloadVideoSchema,
    outputSchema: downloadVideoOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Writes to a deterministic path and overwrites, exactly like the
      // extract_* tools; repeating the call leaves the same state.
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: downloadVideoHandler,
  }),
];
