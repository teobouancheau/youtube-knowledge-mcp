import { defineTool, type ToolDefinition } from './types.js';
import {
  getTranscriptsSchema,
  getTranscriptsOutputSchema,
  getTranscriptsHandler,
  digestPlaylistSchema,
  digestPlaylistOutputSchema,
  digestPlaylistHandler,
} from '../tools/batch.js';
import {
  getTranscriptSchema,
  getTranscriptOutputSchema,
  getTranscriptHandler,
} from '../tools/get-transcript.js';
import {
  searchTranscriptSchema,
  searchTranscriptOutputSchema,
  searchTranscriptHandler,
} from '../tools/search-transcript.js';
import {
  transcribeVideoSchema,
  transcribeVideoOutputSchema,
  transcribeVideoHandler,
} from '../tools/transcribe-video.js';

/**
 * Reading and searching transcripts, singly and in batches. Remote-safe, except
 * transcribe_video, which runs whisper.cpp and writes to this machine's disk.
 */
export const transcriptTools: ToolDefinition[] = [
  defineTool({
    name: 'get_transcript',
    mode: 'all',
    title: 'Get YouTube Video Transcript',
    description:
      'Extract the full transcript from a YouTube video. Supports auto-generated and manual captions. Returns plain text with word count and detected language. Results are cached locally.',
    inputSchema: getTranscriptSchema,
    outputSchema: getTranscriptOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: getTranscriptHandler,
  }),
  defineTool({
    name: 'search_transcript',
    mode: 'all',
    title: 'Search Inside a Transcript',
    description:
      'Find a phrase or pattern inside a video transcript and return each match with its timestamp and a link that opens the video at that moment. Use this instead of reading a whole transcript when you need to locate or cite a specific moment.',
    inputSchema: searchTranscriptSchema,
    outputSchema: searchTranscriptOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: searchTranscriptHandler,
  }),
  defineTool({
    name: 'get_transcripts',
    mode: 'all',
    title: 'Get Transcripts for Several Videos',
    description:
      'Fetch transcripts for up to 25 videos in one call, each capped so the batch cannot flood the context. Videos that have no captions are reported individually rather than failing the whole call.',
    inputSchema: getTranscriptsSchema,
    outputSchema: getTranscriptsOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: getTranscriptsHandler,
  }),
  defineTool({
    name: 'digest_playlist',
    mode: 'all',
    title: 'Digest a Playlist or Channel',
    description:
      'Summarize a playlist or channel in one call: per-video metadata, chapter markers, and optionally transcript word counts. Use this to survey a body of content before deciding what to read in full.',
    inputSchema: digestPlaylistSchema,
    outputSchema: digestPlaylistOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: digestPlaylistHandler,
  }),
  defineTool({
    name: 'transcribe_video',
    mode: 'stdio',
    title: 'Transcribe a Video Locally',
    description:
      'Transcribe the audio of a video that has no captions, on this machine, with whisper.cpp. Slow and CPU-heavy, so call it only when get_transcript reports NO_CAPTIONS. Always pass the spoken language. The result is kept and then read by get_transcript, search_transcript and export_subtitles, marked as a local transcription. Requires ffmpeg, whisper-cli on PATH and YOUTUBE_MCP_WHISPER_MODEL.',
    inputSchema: transcribeVideoSchema,
    outputSchema: transcribeVideoOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: transcribeVideoHandler,
  }),
];
