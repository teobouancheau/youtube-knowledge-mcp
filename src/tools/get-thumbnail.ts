import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { thumbnailQualitySchema, type ThumbnailQuality } from '../thumbnail-schemas.js';
import { YouTubeError } from '../utils/errors.js';
import { probeImage, type ImageProbe } from '../utils/image-dimensions.js';
import { fetchImage, MAX_INLINE_IMAGE_BYTES } from '../utils/image-fetch.js';
import { climb, videoRungs } from '../utils/thumbnail-ladder.js';
import { channelImageFile, entryPath, listThumbnailManifests } from '../utils/thumbnail-store.js';
import { assertChannelId } from '../utils/validate.js';
import { extractVideoId, getChannelInfo } from '../utils/youtube.js';
import { findByChannel } from '../utils/channel-lookup.js';

export const getThumbnailSchema = {
  video: z
    .string()
    .optional()
    .describe('Video ID or URL. Required unless image is avatar or banner'),
  channel: z
    .string()
    .max(256)
    .optional()
    .describe('Channel URL, @handle or name, for image = avatar or banner'),
  image: z
    .enum(['thumbnail', 'avatar', 'banner'])
    .default('thumbnail')
    .describe("A video's thumbnail, or a channel's avatar or banner. Default: thumbnail"),
  quality: thumbnailQualitySchema.default('best'),
};

export const getThumbnailOutputSchema = {
  image: z.enum(['thumbnail', 'avatar', 'banner']),
  videoId: z.string().optional(),
  channelId: z.string().optional(),
  sourceUrl: z.string(),
  variant: z.string(),
  mimeType: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
  fromDisk: z.boolean().describe('True when served from a saved fetch_channel_thumbnails run'),
};

export interface GetThumbnailArgs {
  video?: string;
  channel?: string;
  image: 'thumbnail' | 'avatar' | 'banner';
  quality: ThumbnailQuality;
}

interface Picture {
  bytes: Buffer;
  probe: ImageProbe;
  sourceUrl: string;
  variant: string;
  fromDisk: boolean;
  videoId?: string;
  channelId?: string;
}

/**
 * One image, returned as an MCP image block so the model can look at it.
 *
 * Remote-safe: the image is fetched into memory under a cap and never written.
 * Locally, an image a previous fetch_channel_thumbnails run saved is served
 * from disk instead, so what the model sees is exactly what was stored.
 */
export async function getThumbnailHandler(
  args: GetThumbnailArgs,
  options: { store: boolean } = { store: false }
): Promise<CallToolResult> {
  const picture =
    args.image === 'thumbnail'
      ? await videoPicture(args, options.store)
      : await channelPicture(args, options.store);
  const { bytes, probe, sourceUrl, variant, fromDisk, videoId, channelId } = picture;
  const label = videoId ?? channelId ?? '';

  return {
    content: [
      {
        type: 'text',
        text: `${label} ${args.image}, ${probe.width}x${probe.height} ${probe.format.toUpperCase()}, ${Math.round(bytes.byteLength / 1024)} KB (${variant}${fromDisk ? ', from disk' : ''})`,
      },
      { type: 'image', data: bytes.toString('base64'), mimeType: probe.mimeType },
    ],
    structuredContent: {
      image: args.image,
      ...(videoId === undefined ? {} : { videoId }),
      ...(channelId === undefined ? {} : { channelId }),
      sourceUrl,
      variant,
      mimeType: probe.mimeType,
      width: probe.width,
      height: probe.height,
      bytes: bytes.byteLength,
      fromDisk,
    },
  };
}

async function videoPicture(args: GetThumbnailArgs, store: boolean): Promise<Picture> {
  if (args.video === undefined) {
    throw new YouTubeError('INVALID_INPUT', 'Pass video to fetch a thumbnail.', {
      nextStep: 'Give a video ID or URL, or set image to avatar or banner with a channel.',
    });
  }
  const videoId = extractVideoId(args.video);

  const stored = store ? await storedVideo(videoId) : undefined;
  if (stored !== undefined) return stored;

  const climbed = await climb(
    videoRungs(videoId, undefined, false, args.quality),
    MAX_INLINE_IMAGE_BYTES
  );
  return {
    bytes: climbed.bytes,
    probe: climbed.probe,
    sourceUrl: climbed.rung.url,
    variant: climbed.rung.variant,
    fromDisk: false,
    videoId,
  };
}

async function channelPicture(args: GetThumbnailArgs, store: boolean): Promise<Picture> {
  if (args.channel === undefined || args.image === 'thumbnail') {
    throw new YouTubeError('INVALID_INPUT', `Pass channel to fetch a channel ${args.image}.`, {
      nextStep: 'Give a channel URL, @handle or name.',
    });
  }
  const kind = args.image;

  const stored = store ? await storedChannelImage(args.channel, kind) : undefined;
  if (stored !== undefined) return stored;

  const info = await getChannelInfo(args.channel);
  const channelId = assertChannelId(info.channelId);
  const url = kind === 'avatar' ? info.avatarUrl : info.bannerUrl;
  if (url === undefined) {
    throw new YouTubeError('NOT_FOUND', `${info.name} lists no ${kind}.`);
  }

  const { bytes } = await fetchImage(url, { maxBytes: MAX_INLINE_IMAGE_BYTES });
  const probe = probeImage(bytes);
  if (probe === undefined) throw new YouTubeError('FETCH_FAILED', 'The image could not be read.');
  return { bytes, probe, sourceUrl: url, variant: 'uncropped', fromDisk: false, channelId };
}

/** A saved thumbnail for this video in any fetched channel, when there is one. */
async function storedVideo(videoId: string): Promise<Picture | undefined> {
  for (const manifest of await listThumbnailManifests()) {
    const entry = manifest.videos[videoId];
    const path = entry === undefined ? undefined : entryPath(manifest.channel.channelId, entry);
    if (entry === undefined || path === undefined) continue;
    const picture = await fromDisk(path, entry.sourceUrl ?? '', entry.variant ?? 'saved');
    if (picture !== undefined) return { ...picture, videoId };
  }
  return undefined;
}

async function storedChannelImage(
  channel: string,
  kind: 'avatar' | 'banner'
): Promise<Picture | undefined> {
  const [manifest] = findByChannel(await listThumbnailManifests(), channel);
  const image = manifest?.[kind];
  if (manifest === undefined || image === undefined) return undefined;
  const path = channelImageFile(manifest.channel.channelId, image);
  if (path === undefined) return undefined;
  const picture = await fromDisk(path, image.sourceUrl ?? '', image.variant ?? 'saved');
  return picture === undefined ? undefined : { ...picture, channelId: manifest.channel.channelId };
}

async function fromDisk(
  path: string,
  sourceUrl: string,
  variant: string
): Promise<Picture | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return undefined;
  }
  const probe = probeImage(bytes);
  return probe === undefined ? undefined : { bytes, probe, sourceUrl, variant, fromDisk: true };
}
