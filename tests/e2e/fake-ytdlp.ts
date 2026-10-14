import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A stand-in for yt-dlp that answers from local files, so the server's own wiring can
 * be exercised end to end without YouTube.
 *
 * It understands exactly what the tools ask for, and nothing more:
 *   --version  prints a version
 *   -x         copies FAKE_AUDIO_<id> to the audio file named by -o
 *   --get-url  prints FAKE_STREAM_URL
 *   --dump-single-json  prints the channel metadata in FAKE_CHANNEL
 *   --flat-playlist  prints the entries of the channel tab named by the target, from
 *              FAKE_TABS; a tab that file does not list is "not a tab this channel has"
 *   -j / --print  prints the row for the video id found in the target, from FAKE_ROWS
 * Anything else succeeds silently, which for subtitle fetches means "no captions".
 */

const SOURCE = `
const { copyFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const target = args[args.length - 1] ?? '';
const rows = () => JSON.parse(readFileSync(process.env.FAKE_ROWS, 'utf-8'));
const rowFor = () => {
  const all = rows();
  const id = Object.keys(all).find((key) => target.includes(key));
  return id === undefined ? undefined : all[id];
};

if (args.includes('--version')) { console.log('2026.07.04'); process.exit(0); }

if (args.includes('--dump-single-json')) {
  console.log(readFileSync(process.env.FAKE_CHANNEL, 'utf-8'));
  process.exit(0);
}

if (args.includes('--flat-playlist')) {
  const tab = (target.match(/\\/(videos|shorts|streams|releases|podcasts|playlists)$/) ?? [])[1];
  const tabs = JSON.parse(readFileSync(process.env.FAKE_TABS, 'utf-8'));
  if (tab === undefined || tabs[tab] === undefined) {
    console.error('ERROR: This channel does not have a ' + String(tab) + ' tab');
    process.exit(1);
  }
  for (const entry of tabs[tab]) console.log(JSON.stringify(entry));
  process.exit(0);
}

if (args.includes('-x')) {
  const template = args[args.indexOf('-o') + 1];
  const row = rowFor();
  const audio = row === undefined ? undefined : process.env['FAKE_AUDIO_' + row.id];
  if (audio === undefined) { console.error('ERROR: Video unavailable'); process.exit(1); }
  copyFileSync(audio, template.replace('%(ext)s', 'wav'));
  process.exit(0);
}

if (args.includes('--get-url')) { console.log(process.env.FAKE_STREAM_URL); process.exit(0); }

if (args.includes('-j') || args.includes('--print')) {
  const row = rowFor();
  if (row === undefined) { console.error('ERROR: Video unavailable'); process.exit(1); }
  console.log(JSON.stringify(row));
  process.exit(0);
}

process.exit(0);
`;

/** Writes the stand-in under `directory` and returns the directory to put first on PATH. */
export async function installFakeYtDlp(directory: string): Promise<string> {
  const shimDir = join(directory, 'shim');
  await mkdir(shimDir, { recursive: true });

  const script = join(shimDir, 'yt-dlp.cjs');
  await writeFile(script, SOURCE);

  const executable = join(shimDir, 'yt-dlp');
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(executable, 0o755);

  return shimDir;
}

/** A yt-dlp row with just enough for the tools to treat it as a playable video. */
export function fakeRow(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Video ${id}`,
    channel: 'A channel',
    upload_date: '20260101',
    duration: 10,
    subtitles: {},
    automatic_captions: {},
    ...fields,
  };
}
