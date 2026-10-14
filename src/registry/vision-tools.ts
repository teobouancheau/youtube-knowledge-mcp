import { defineTool, type ToolDefinition } from './types.js';
import {
  extractFramesSchema,
  extractFramesOutputSchema,
  extractFramesHandler,
  contactSheetSchema,
  contactSheetOutputSchema,
  contactSheetHandler,
} from '../tools/frames.js';
import {
  detectScenesSchema,
  detectScenesOutputSchema,
  detectScenesHandler,
} from '../tools/detect-scenes.js';

/**
 * Looking at a video. Local only because ffmpeg runs on this machine, but unlike the
 * media tools these write nothing: every picture comes back inline.
 */
export const visionTools: ToolDefinition[] = [
  defineTool({
    name: 'extract_frames',
    mode: 'stdio',
    title: 'Look at Video Frames',
    description:
      'See what is on screen. Returns several frames from a video as images you can read, at exact timestamps or spread evenly across a window. Use after search_transcript or get_chapters to check the visuals at a moment, or to read slides and on-screen text. Nothing is written to disk. Requires ffmpeg.',
    inputSchema: extractFramesSchema,
    outputSchema: extractFramesOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: extractFramesHandler,
  }),
  defineTool({
    name: 'extract_contact_sheet',
    mode: 'stdio',
    title: 'Video Contact Sheet',
    description:
      'Skim a whole video in one image: a grid of frames spread evenly across it, with the timestamp of every cell listed in reading order. The cheapest way to learn what a video looks like before choosing moments to inspect with extract_frames. Requires ffmpeg.',
    inputSchema: contactSheetSchema,
    outputSchema: contactSheetOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: contactSheetHandler,
  }),
  defineTool({
    name: 'detect_scenes',
    mode: 'stdio',
    title: 'Detect Scene Cuts',
    description:
      'Find where a video cuts from one shot to another, as timestamps with links. Use to find the real boundaries of b-roll, interviews and slides before extract_clip or extract_frames. Reads up to 15 minutes per call. Requires ffmpeg.',
    inputSchema: detectScenesSchema,
    outputSchema: detectScenesOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: detectScenesHandler,
  }),
];
