import type { BrainManifest } from '../brain-schemas.js';
import { listManifests } from './brain-storage.js';
import { findByChannel } from './channel-lookup.js';
import { YouTubeError } from './errors.js';

/**
 * Find a brain from whatever the caller called the channel.
 *
 * Every brain tool except `build_brain` answers from disk, so none of them
 * should need the network to work out which brain is meant. The matching
 * itself is shared with every other channel-keyed store; what is specific here
 * is what to say when there is no brain, or more than one.
 */
export async function resolveBrain(channel: string): Promise<BrainManifest> {
  const manifests = await listManifests();
  const matches = findByChannel(manifests, channel);

  const [first, second] = matches;

  if (first === undefined) throw noBrain(channel, manifests);
  if (second !== undefined) throw ambiguous(channel, matches);

  return first;
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
