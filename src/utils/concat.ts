import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStem } from './clips.js';
import { YouTubeError } from './errors.js';
import { runFfmpeg } from './ffmpeg.js';
import { dataDir } from './paths.js';
import { requireFfmpeg } from './preflight.js';
import { assertInsideHome, resolveOutputDir } from './validate.js';
import { TIMEOUTS } from './ytdlp.js';

/**
 * Joining clips into one video, in the order given.
 *
 * The inputs are files already on this machine, typically what extract_clip wrote.
 * They are re-encoded rather than copied, because clips cut at different moments or
 * from different sources rarely share the exact stream parameters a copy needs.
 */

export const MIN_CONCAT_FILES = 2;
export const MAX_CONCAT_FILES = 20;

const MONTAGES_DIR = dataDir('montages');
const NAME_HASH_LENGTH = 8;

export interface ConcatResult {
  filePath: string;
  clips: number;
  bytes: number;
}

/** A path as one entry of ffmpeg's concat list: single-quoted, with any quote escaped. */
function listEntry(path: string): string {
  return `file '${path.replace(/'/g, `'\\''`)}'`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the result may go.
 *
 * Never onto one of the clips being joined: ffmpeg would read and write the same file
 * and destroy it. And never over a file the caller did not make: a name the caller
 * chose can collide with anything in the folder, so an existing file is refused. A name
 * this server derived from the inputs is its own, so repeating the call rewrites it.
 */
async function assertSafeOutput(
  filePath: string,
  inputs: string[],
  chosenName: boolean
): Promise<void> {
  if (inputs.includes(filePath)) {
    throw new YouTubeError(
      'INVALID_INPUT',
      `The result would overwrite ${filePath}, a clip being joined.`,
      {
        nextStep: 'Choose a different name, or another outputDir.',
      }
    );
  }
  if (chosenName && (await exists(filePath))) {
    throw new YouTubeError('INVALID_INPUT', `${filePath} already exists.`, {
      nextStep: 'Choose a different name, or remove the existing file first.',
    });
  }
}

async function assertReadableFile(path: string): Promise<void> {
  let isFile: boolean;
  try {
    isFile = (await stat(path)).isFile();
  } catch (error) {
    throw new YouTubeError('NOT_FOUND', `There is no file at ${path}.`, {
      nextStep: 'Pass the paths extract_clip returned, in the order you want them.',
      cause: error,
    });
  }
  if (!isFile) {
    throw new YouTubeError('INVALID_INPUT', `${path} is not a file.`, {
      nextStep: 'Pass paths to video files, not folders.',
    });
  }
}

export async function concatClips(
  inputs: string[],
  options: { name?: string; outputDir?: string }
): Promise<ConcatResult> {
  if (inputs.length < MIN_CONCAT_FILES || inputs.length > MAX_CONCAT_FILES) {
    throw new YouTubeError(
      'INVALID_INPUT',
      `Join between ${String(MIN_CONCAT_FILES)} and ${String(MAX_CONCAT_FILES)} clips at a time.`,
      { nextStep: 'Join in stages: concatenate groups, then concatenate the results.' }
    );
  }

  await requireFfmpeg('Joining clips');
  const targetDir = resolveOutputDir(options.outputDir, MONTAGES_DIR);

  const paths = inputs.map((input) => assertInsideHome(input, 'clip'));
  for (const path of paths) await assertReadableFile(path);

  const hash = createHash('sha256')
    .update(paths.join('\n'))
    .digest('hex')
    .slice(0, NAME_HASH_LENGTH);
  const stem =
    options.name === undefined ? `montage-${hash}` : safeStem(options.name, `montage-${hash}`);
  const filePath = join(targetDir, `${stem}.mp4`);
  await assertSafeOutput(filePath, paths, options.name !== undefined);
  const resultExisted = await exists(filePath);

  await mkdir(targetDir, { recursive: true });
  // One folder per call: two calls joining the same clips must not share, and then
  // delete, each other's list.
  const workDir = await mkdtemp(join(targetDir, '.concat-'));
  const listPath = join(workDir, 'list.txt');
  await writeFile(listPath, `${paths.map(listEntry).join('\n')}\n`, 'utf-8');

  try {
    await runFfmpeg(
      [
        // The list is the only thing ffmpeg reads, and it names files only.
        '-protocol_whitelist',
        'file',
        '-f',
        'concat',
        // Paths in the list are absolute and already checked above.
        '-safe',
        '0',
        '-i',
        listPath,
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        '-y',
        filePath,
      ],
      {
        failure: 'ffmpeg could not join those clips.',
        nextStep: 'Check that every file is a playable video, or call check_health.',
        // Joining re-encodes, so it takes as long as the clips do; the client's
        // cancellation is the lever, as for a download.
        timeoutMs: TIMEOUTS.download,
      }
    );
  } catch (error) {
    // Only a file this call began is removed: before it, nothing existed at that path
    // unless the name was derived, and a derived name is this server's own.
    if (!resultExisted) await rm(filePath, { force: true });
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  return { filePath, clips: paths.length, bytes: (await stat(filePath)).size };
}
