import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { listTags } from './utils/storage.js';

/**
 * Reusable workflows, exposed as MCP prompts.
 *
 * These encode the sequences that were previously buried in the server's
 * instructions string, where a client could read them but not invoke them.
 */

function userMessage(text: string): {
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
} {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

const video = z.string().describe('YouTube video ID or URL');

/**
 * An optional prompt argument that offers completions.
 *
 * The SDK looks for the completion marker in two places, and unwraps
 * differently in each: registering the prompt unwraps one level of ZodOptional
 * and inspects the schema inside, while serving a `completion/complete` request
 * inspects the field as declared. Marking only the inner schema advertises the
 * capability but then completes to nothing; marking only the outer one never
 * advertises it at all, and the client gets "method not found". Both layers
 * therefore carry the marker.
 */
function completableOptional(
  schema: z.ZodString,
  // Undefined when the client asks for completions before anything is typed.
  complete: (value: string | undefined) => Promise<string[]>
): z.ZodOptional<z.ZodString> {
  return completable(completable(schema, complete).optional(), complete);
}

export function registerPrompts(server: McpServer, mode: 'stdio' | 'http'): void {
  server.registerPrompt(
    'summarize_video',
    {
      title: 'Summarize a video',
      description:
        "Read a video's chapters and transcript and produce a structured summary with timestamped citations.",
      argsSchema: {
        video,
        depth: z
          .enum(['brief', 'standard', 'detailed'])
          .optional()
          .describe('How much detail to produce. Default: standard'),
      },
    },
    ({ video: target, depth }) =>
      userMessage(
        [
          `Summarize the YouTube video ${target}.`,
          '',
          '1. Call get_video_info for the title, channel and description.',
          '2. Call get_chapters to learn the structure before reading anything long.',
          `3. Call get_transcript with format="timestamped"${
            depth === 'brief' ? ' and maxChars=8000' : ''
          }.`,
          '',
          `Write a ${depth ?? 'standard'} summary. Cite specific moments as [MM:SS] and include`,
          'a https://www.youtube.com/watch?v=...&t=...s link for each key claim, so every point',
          'can be checked against the source.',
        ].join('\n')
      )
  );

  server.registerPrompt(
    'extract_skill',
    {
      title: 'Extract a reusable skill',
      description:
        'Turn a how-to or tutorial video into a step-by-step procedure someone could follow without watching it.',
      argsSchema: { video },
    },
    ({ video: target }) =>
      userMessage(
        [
          `Extract the practical technique taught in ${target} as a reusable procedure.`,
          '',
          'Read the transcript with get_transcript, using get_chapters first if the video has them.',
          'Produce: prerequisites, numbered steps, the specific commands or settings mentioned,',
          'and the mistakes the author warns about. Omit anecdotes and filler.',
          '',
          'Keep a [MM:SS] reference on each step so it can be checked against the video.',
        ].join('\n')
      )
  );

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
    'clip_from_quote',
    {
      title: 'Clip a moment from a quote',
      description:
        'Find a phrase in a video and cut a clip around it — the search-then-extract workflow.',
      argsSchema: {
        video,
        quote: z.string().describe('Words spoken in the video, roughly'),
        padding: z
          .string()
          .optional()
          .describe('Seconds of context to keep either side. Default: 5'),
      },
    },
    ({ video: target, quote, padding }) => {
      const pad = padding ?? '5';
      return userMessage(
        [
          `Find where "${quote}" is said in ${target} and cut a clip around it.`,
          '',
          `1. search_transcript with query="${quote}" to get the timestamp.`,
          `2. If several moments match, report them and ask which one before cutting.`,
          `3. extract_clip starting ${pad}s before the match and ending ${pad}s after the sentence finishes.`,
          '',
          'Report the clip path and the timestamp it came from.',
        ].join('\n')
      );
    }
  );

  // Library prompts only exist where the library does.
  if (mode !== 'stdio') return;

  server.registerPrompt(
    'review_library',
    {
      title: 'Review the knowledge library',
      description: 'Survey what is saved locally on a topic and synthesize it.',
      argsSchema: {
        // Completion over real tags, so the client can offer what actually exists.
        tag: completableOptional(z.string().describe('Restrict to this tag'), async (value) => {
          const prefix = (value ?? '').toLowerCase();
          const tags = await listTags();
          return tags.filter((candidate) => candidate.toLowerCase().startsWith(prefix));
        }),
      },
    },
    ({ tag }) =>
      userMessage(
        [
          tag === undefined
            ? 'Review everything saved in the YouTube knowledge library.'
            : `Review the library entries tagged "${tag}".`,
          '',
          '1. list_library to see what is there.',
          '2. get_library_item for the relevant entries, or search_library if you have a specific question.',
          '',
          'Synthesize the themes across them, note where saved notes contradict each other,',
          'and point out gaps worth filling.',
        ].join('\n')
      )
  );
}
