import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { userMessage } from './prompts-shared.js';

/** Prompts that survey more than one video: comparisons, research, and a channel's output and thumbnails. */
export function registerResearchPrompts(server: McpServer): void {
  server.registerPrompt(
    'compare_videos',
    {
      title: 'Compare several videos',
      description: 'Compare how multiple videos treat the same topic, and where they disagree.',
      argsSchema: {
        videos: z.string().describe('Comma-separated video IDs or URLs'),
        focus: z.string().optional().describe('A specific question to compare them on'),
      },
    },
    ({ videos, focus }) =>
      userMessage(
        [
          `Compare these videos: ${videos}`,
          '',
          'Call get_transcripts once with all of them rather than fetching each separately.',
          focus === undefined ? '' : `Focus on: ${focus}`,
          '',
          'Report where they agree, where they genuinely disagree (not just differ in emphasis),',
          'and what each covers that the others do not. Attribute every claim to a specific video.',
        ]
          .filter(Boolean)
          .join('\n')
      )
  );

  server.registerPrompt(
    'research_topic',
    {
      title: 'Research a topic on YouTube',
      description:
        'Search for videos on a topic, survey them cheaply, then read the ones worth reading.',
      argsSchema: {
        topic: z.string().describe('What to research'),
        depth: z
          .enum(['survey', 'deep'])
          .optional()
          .describe('survey reads metadata only; deep reads transcripts. Default: survey'),
      },
    },
    ({ topic, depth }) =>
      userMessage(
        [
          `Research "${topic}" on YouTube.`,
          '',
          '1. search_videos to find candidates, and search_channels for authoritative sources.',
          '2. Judge relevance from titles, durations and view counts before fetching anything large.',
          depth === 'deep'
            ? '3. get_transcripts for the shortlist, then search_transcript to locate specific claims.'
            : '3. get_video_info and get_chapters for the shortlist. Only read a transcript if a video looks essential.',
          '',
          'Report what the consensus is, where sources disagree, and which video best answers the question.',
        ].join('\n')
      )
  );

  server.registerPrompt(
    'channel_deep_dive',
    {
      title: 'Survey a channel',
      description: "Characterize a channel's output and identify its most substantial videos.",
      argsSchema: {
        channel: z.string().describe('Channel URL, @handle, or name'),
        limit: z.string().optional().describe('How many videos to survey. Default: 20'),
      },
    },
    ({ channel, limit }) =>
      userMessage(
        [
          `Survey the YouTube channel ${channel}.`,
          '',
          `1. get_channel_info for context, then digest_playlist with limit=${limit ?? '20'}.`,
          '2. Identify recurring themes, the format the channel favours, and how it has changed over time.',
          '3. Name the three videos most worth watching and say why.',
        ].join('\n')
      )
  );

  server.registerPrompt(
    'study_thumbnails',
    {
      title: "Study a channel's thumbnails",
      description:
        "Save a channel's thumbnails, look at a sample, and describe the recurring layout, colour and text patterns with the videos as citations.",
      argsSchema: {
        channel: z.string().describe('Channel URL, @handle, or name'),
        sample: z.string().optional().describe('How many thumbnails to look at. Default: 6'),
      },
    },
    ({ channel, sample }) =>
      userMessage(
        [
          `Study the thumbnails of the YouTube channel ${channel}.`,
          '',
          '1. Call fetch_channel_thumbnails for the channel (local mode), or get_thumbnail on a few videos from fetch_videos if only the remote tools are available.',
          `2. Look at ${sample ?? '6'} of them with get_thumbnail, spread across the channel's history, plus the avatar.`,
          '3. Describe what recurs: composition, face placement, colour palette, text size and wording, and how these changed over time.',
          '4. Cite each observation with the video ids it comes from. Do not describe an image you have not looked at.',
        ].join('\n')
      )
  );
}
