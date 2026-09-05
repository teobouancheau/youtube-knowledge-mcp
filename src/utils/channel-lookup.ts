import type { ChannelInfo } from './youtube.js';

/**
 * Find the records that belong to a channel, from whatever the caller called it.
 *
 * Every local tool answers from disk, so none of them should need the network
 * to work out which channel is meant — asking YouTube to resolve a handle
 * before every search would put a round trip in front of a lookup that is
 * otherwise instant, and would make the data unusable offline. A stored record
 * already carries the channel's id, handle, name and URL, which is everything
 * a caller is likely to type.
 */

const CHANNEL_ID_IN_TEXT = /UC[A-Za-z0-9_-]{22}/;
const HANDLE_IN_TEXT = /@[\w.-]+/;

export function findByChannel<T extends { channel: ChannelInfo }>(
  items: T[],
  channel: string
): T[] {
  const wanted = candidates(channel);
  return items.filter((item) => keysOf(item.channel).some((key) => wanted.has(key)));
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

function keysOf({ channelId, handle, name, channelUrl }: ChannelInfo): string[] {
  return [channelId, handle, handle.replace(/^@/, ''), name, channelUrl]
    .map(normalize)
    .filter((key) => key !== '');
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}
