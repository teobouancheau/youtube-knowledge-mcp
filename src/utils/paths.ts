import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Everything this server writes lives under one directory in the user's home:
 * transcripts, the library, clips, and the channel brains.
 *
 * Spelled out in six places before this existed, which is five chances for a
 * rename to leave a stray directory behind.
 */
export function dataDir(...segments: string[]): string {
  return join(homedir(), '.youtube-knowledge', ...segments);
}
