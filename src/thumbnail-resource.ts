import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guardedResource } from './utils/guard.js';
import { listThumbnailManifests, requireThumbnailManifest } from './utils/thumbnail-store.js';

/**
 * A channel's saved thumbnails as a resource: the manifest only. The images
 * themselves are files the manifest points at; a client that wants to see one
 * calls get_thumbnail.
 */
export function registerThumbnailResource(server: McpServer): void {
  server.registerResource(
    'thumbnails',
    new ResourceTemplate('youtube://thumbnails/{channelId}/manifest', {
      list: guardedResource(async () => {
        const sets = await listThumbnailManifests();
        return {
          resources: sets.map((set) => ({
            uri: `youtube://thumbnails/${set.channel.channelId}/manifest`,
            name: `${set.channel.name} (thumbnails)`,
            mimeType: 'application/json',
          })),
        };
      }),
    }),
    {
      title: 'Saved channel thumbnails',
      description:
        'What fetch_channel_thumbnails saved for a channel: every image, its decoded size, and where it is on disk.',
      mimeType: 'application/json',
    },
    guardedResource(async (uri, { channelId }) => {
      const manifest = await requireThumbnailManifest(first(channelId));
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(manifest, null, 2) },
        ],
      };
    })
  );
}

/** Template variables arrive as a string or, for a repeated segment, an array. */
function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}
