import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLibraryItem, listLibrary } from './utils/storage.js';
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
}
