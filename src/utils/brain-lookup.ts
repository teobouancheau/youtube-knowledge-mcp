import type { BrainManifest } from '../brain-schemas.js';
import { listManifests } from './brain-storage.js';
import { YouTubeError } from './errors.js';

/**
 * Find a brain from whatever the caller called the channel.
 *
 * Every brain tool except `build_brain` answers from disk, so none of them
 * should need the network to work out which brain is meant — asking YouTube to
 * resolve a handle before every search would put a round trip in front of a
 * lookup that is otherwise instant, and would make a brain unusable offline.
 *
 * The manifest already records the channel's id, handle, name and URL, which is
 * everything a caller is likely to type.
 */

const CHANNEL_ID_IN_TEXT = /UC[A-Za-z0-9_-]{22}/;
const HANDLE_IN_TEXT = /@[\w.-]+/;

export async function resolveBrain(channel: string): Promise<BrainManifest> {
  const manifests = await listManifests();
  const wanted = candidates(channel);

  const matches = manifests.filter((manifest) => keysOf(manifest).some((key) => wanted.has(key)));

  const [first, second] = matches;

  if (first === undefined) throw noBrain(channel, manifests);
  if (second !== undefined) throw ambiguous(channel, matches);

  return first;
}

function candidates(channel: string): Set<string> {
  const keys = new Set<string>([normalize(channel)]);

  const id = CHANNEL_ID_IN_TEXT.exec(channel)?.[0];
  if (id !== undefined) keys.add(normalize(id));

  const handle = HANDLE_IN_TEXT.exec(channel)?.[0];
  if (handle !== undefined) {
    keys.add(normalize(handle));
    keys.add(normalize(handle.slice(1)));
  }

  return keys;
}

function keysOf(manifest: BrainManifest): string[] {
  const { channelId, handle, name, channelUrl } = manifest.channel;

  return [channelId, handle, handle.replace(/^@/, ''), name, channelUrl]
    .map(normalize)
    .filter((key) => key !== '');
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

function noBrain(channel: string, manifests: BrainManifest[]): YouTubeError {
  const built = manifests.map((manifest) => manifest.channel.handle || manifest.channel.name);

  return new YouTubeError('NOT_FOUND', `No brain has been built for "${channel}".`, {
    nextStep:
      built.length === 0
        ? 'Call build_brain with the channel URL or handle to build one.'
        : `Call build_brain to build it. Brains that exist: ${built.join(', ')}.`,
  });
}

function ambiguous(channel: string, matches: BrainManifest[]): YouTubeError {
  const names = matches.map((manifest) => manifest.channel.channelId);

  return new YouTubeError('INVALID_INPUT', `"${channel}" matches more than one brain.`, {
    nextStep: `Use the channel id instead: ${names.join(', ')}.`,
  });
}
