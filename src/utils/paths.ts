import { mkdir } from 'node:fs/promises';
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

/** Permission bits for the directories this server owns: the user's data, nobody else's. */
export const PRIVATE_DIR_MODE = 0o700;

/**
 * Create a directory the server owns, readable by its user only.
 *
 * Media that a tool writes for the user to open — downloads, clips, frames —
 * keeps the umask default; this is for the transcript cache, the library, the
 * brains and their indexes.
 */
export async function ensurePrivateDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  return path;
}
