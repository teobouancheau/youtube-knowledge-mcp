import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { z } from 'zod';

/**
 * Reading and writing the JSON documents this server keeps on disk.
 *
 * Both halves exist because the library and the brains make the same two
 * mistakes otherwise. Writing straight to the destination means an interrupted
 * process leaves a half-written file where a valid one used to be — survivable
 * for a cache, fatal for a brain manifest that is checkpointed every few videos
 * across a build lasting tens of minutes. Reading without validation means a
 * file edited by hand, or truncated by that same crash, propagates `undefined`
 * into code that assumed a shape.
 */

export interface WriteJsonOptions {
  /**
   * Indent the output. Worth it for files a human may open; not for a search
   * index, where indentation is most of the bytes.
   */
  pretty?: boolean;
}

/**
 * Write JSON through a temporary file and rename it into place.
 *
 * `rename` within a directory is atomic on POSIX and on Windows via
 * `MoveFileEx`, so a reader sees either the previous document or the new one,
 * never a partial write.
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: WriteJsonOptions = {}
): Promise<void> {
  const { pretty = true } = options;
  const serialised = JSON.stringify(value, null, pretty ? 2 : undefined);

  // A shared temporary name would let two writers of the same document destroy
  // each other's staging file, and the loser's rename would fail on a path that
  // the winner had already moved away.
  const temporaryPath = `${path}.${process.pid}.${writeSequence++}.tmp`;

  try {
    await writeFile(temporaryPath, serialised, 'utf-8');
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

let writeSequence = 0;

/**
 * Read and validate a JSON document, or `undefined` if it is missing,
 * unparseable or does not match.
 *
 * Callers decide what a missing document means — an empty library, a brain that
 * has not been built — which is information this function does not have.
 */
export async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;

  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(path, 'utf-8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
