import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { userMessage } from './prompts-shared.js';

/** Prompts for the channel brains. Local only, like the tools they drive. */
export function registerBrainPrompts(server: McpServer): void {
  server.registerPrompt(
    'create_brain',
    {
      title: 'Create a brain for a YouTuber',
      description:
        'Read a channel into a searchable corpus, then write a grounded account of the creator from what they actually said.',
      argsSchema: {
        channel: z.string().describe('Channel URL, @handle, or name'),
        limit: z.string().optional().describe('How many videos to read. Default: 100'),
      },
    },
    ({ channel, limit }) =>
      userMessage(
        [
          `Build a brain for the YouTube channel ${channel}, then write its profile.`,
          '',
          `1. build_brain with maxVideos=${limit ?? '100'}. This takes a while. If it reports`,
          '   stoppedEarly, call it again until it does not.',
          '2. get_brain_info to see what was actually read — a profile written over a channel',
          '   that is half unread is a profile of the half that loaded.',
          '3. Probe the corpus with several ask_brain calls: the subjects it returns to, the',
          '   positions it argues for, the advice it repeats, how it opens and closes a video.',
          '   The recurring phrases in get_brain_info are a good place to start.',
          '4. save_brain_profile with what you found.',
          '',
          'Every claim in the profile must be supported by a passage you retrieved, cited as',
          '[MM:SS] with its link. Where the corpus does not support a claim, leave the claim out.',
          'Do not describe the creator as a person, a personality or a brand — describe what',
          'their videos say and how they say it.',
        ].join('\n')
      )
  );

  server.registerPrompt(
    'ask_creator',
    {
      title: 'Ask what a creator has said',
      description:
        'Answer a question strictly from a channel brain, citing the moments the answer comes from.',
      argsSchema: {
        channel: z.string().describe('Channel URL, @handle, or name of an existing brain'),
        question: z.string().describe('What you want to know'),
      },
    },
    ({ channel, question }) =>
      userMessage(
        [
          `Answer this about ${channel}, using only their brain: ${question}`,
          '',
          '1. ask_brain with the question. Then ask again with the words the creator would',
          '   actually use — passages are matched as spoken, not as summarised.',
          '2. Answer from the passages you got back, citing each point as [MM:SS] with its link.',
          '',
          'If the passages do not answer the question, say so and say what they do cover.',
          'Do not fill the gap from what you already know about this person: an answer that',
          'cannot be traced to a timestamp is not an answer from the brain.',
        ].join('\n')
      )
  );
}
