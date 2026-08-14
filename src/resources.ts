import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLibraryItem, listLibrary } from './utils/storage.js';
import { hasProfile, listManifests, readProfile, requireManifest } from './utils/brain-storage.js';
import { YouTubeError } from './utils/errors.js';
import { getTranscript } from './utils/youtube.js';
import { segmentsToTimestamped } from './utils/transcript.js';

/**
 * Saved notes and cached transcripts, exposed as MCP resources.
 *
 * A client can attach these directly as context rather than spending a tool call
 * to fetch them, which is what resources are for. Library resources are only
 * registered in stdio mode, matching the tools that write them.
 */

export function registerResources(server: McpServer, mode: 'stdio' | 'http'): void {
  server.registerResource(
    'transcript',
    new ResourceTemplate('youtube://transcript/{videoId}', { list: undefined }),
    {
      title: 'Video transcript',
      description: 'Timestamped transcript for a YouTube video, fetched and cached on first read.',
      mimeType: 'text/plain',
    },
    async (uri, { videoId }) => {
      const id = Array.isArray(videoId) ? videoId[0] : videoId;
      const transcript = await getTranscript(id ?? '');

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/plain',
            text: segmentsToTimestamped(transcript.segments),
          },
        ],
      };
    }
  );

  if (mode !== 'stdio') return;

  server.registerResource(
    'library-item',
    new ResourceTemplate('youtube://library/{videoId}/{contentType}', {
      // Enumerate what is actually saved, so a client can browse the library.
      list: async () => {
        const items = await listLibrary();
        return {
          resources: items.flatMap((item) => [
            ...(item.hasSummary
              ? [
                  {
                    uri: `youtube://library/${item.videoId}/summary`,
                    name: `${item.title} (summary)`,
                    mimeType: 'text/markdown',
                  },
                ]
              : []),
            ...(item.hasSkill
              ? [
                  {
                    uri: `youtube://library/${item.videoId}/skill`,
                    name: `${item.title} (skill)`,
                    mimeType: 'text/markdown',
                  },
                ]
              : []),
          ]),
        };
      },
    }),
    {
      title: 'Saved library note',
      description: 'A summary or skill note previously saved to the local knowledge library.',
      mimeType: 'text/markdown',
    },
    async (uri, { videoId, contentType }) => {
      const id = Array.isArray(videoId) ? videoId[0] : videoId;
      const type = Array.isArray(contentType) ? contentType[0] : contentType;
      const wanted = type === 'skill' ? 'skill' : 'summary';

      const item = await getLibraryItem(id ?? '', wanted);
      const text = (wanted === 'skill' ? item.skill : item.summary) ?? '';

      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    }
  );

  server.registerResource(
    'brain',
    new ResourceTemplate('youtube://brain/{channelId}/{part}', {
      // Only what a client can usefully attach: the manifest describes the
      // whole brain, and the profile is the written account of it. The passages
      // are not offered as a resource — they are tens of megabytes and exist to
      // be searched, not read.
      list: async () => {
        const brains = await listManifests();
        return {
          resources: brains.flatMap((brain) => [
            {
              uri: `youtube://brain/${brain.channel.channelId}/manifest`,
              name: `${brain.channel.name} (brain)`,
              mimeType: 'application/json',
            },
            ...(hasProfile(brain.channel.channelId)
              ? [
                  {
                    uri: `youtube://brain/${brain.channel.channelId}/profile`,
                    name: `${brain.channel.name} (profile)`,
                    mimeType: 'text/markdown',
                  },
                ]
              : []),
          ]),
        };
      },
    }),
    {
      title: 'Channel brain',
      description:
        "A channel brain's manifest — what it covers and what it measured — or the written profile saved beside it.",
      mimeType: 'application/json',
    },
    async (uri, { channelId, part }) => {
      const id = first(channelId);
      const wanted = first(part);

      // Returning the manifest for an unrecognised part would answer a question
      // nobody asked, and look like the URI was understood.
      if (wanted !== 'manifest' && wanted !== 'profile') {
        throw new YouTubeError('INVALID_INPUT', `"${wanted}" is not part of a brain.`, {
          nextStep: `Read youtube://brain/${id}/manifest or youtube://brain/${id}/profile.`,
        });
      }

      if (wanted === 'profile') {
        const profile = await readProfile(id);
        if (profile === undefined) {
          throw new YouTubeError('NOT_FOUND', `No profile has been saved for ${id}.`, {
            nextStep:
              'Call save_brain_profile to write one, after reading the brain with ask_brain.',
          });
        }
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: profile }] };
      }

      const manifest = await requireManifest(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(manifest, null, 2),
          },
        ],
      };
    }
  );
}

/** Template variables arrive as a string or, for a repeated segment, an array. */
function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}
