// Renders every raster and favicon asset from assets/icon.svg, the single source of the mark.
// Run with `npm run render:icon`; commit the outputs together with the SVG.
//
// Rendering is done by rsvg-convert, the command-line tool of librsvg, the SVG renderer of
// the GNOME project. It is not an npm dependency: install it with the system package
// manager (macOS: `brew install librsvg`; Debian/Ubuntu: `apt install librsvg2-bin`).
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SOURCE = new URL('../assets/icon.svg', import.meta.url);
const ASSETS = new URL('../assets/', import.meta.url);
const PLUGIN_ICON = new URL('../plugin/icon.png', import.meta.url);

const FULL_VIEWBOX = '0 0 512 512';
// The mark sits on a 32px margin; a favicon wants the square edge to edge.
const CROPPED_VIEWBOX = '32 32 448 448';
const PLUGIN_ICON_SIZE = 512;
const FAVICON_SIZES = [32, 48];

/** The PNG of `svg` at `size` pixels wide, rendered by rsvg-convert reading and writing pipes. */
async function render(svg, size) {
  const pending = run('rsvg-convert', ['--width', String(size), '--format', 'png'], {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  pending.child.stdin?.end(svg);

  try {
    return (await pending).stdout;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        'rsvg-convert is not installed. macOS: brew install librsvg. Debian/Ubuntu: apt install librsvg2-bin.',
        { cause: error }
      );
    }
    throw error;
  }
}

function cropToSquare(svg) {
  if (!svg.includes(`viewBox="${FULL_VIEWBOX}"`)) {
    throw new Error(`assets/icon.svg no longer declares viewBox="${FULL_VIEWBOX}"`);
  }
  return svg.replace(`viewBox="${FULL_VIEWBOX}"`, `viewBox="${CROPPED_VIEWBOX}"`);
}

const svg = await readFile(SOURCE, 'utf-8');
const favicon = cropToSquare(svg);

await mkdir(ASSETS, { recursive: true });
await writeFile(PLUGIN_ICON, await render(svg, PLUGIN_ICON_SIZE));
await writeFile(new URL('favicon.svg', ASSETS), favicon);
for (const size of FAVICON_SIZES) {
  await writeFile(new URL(`favicon-${size}.png`, ASSETS), await render(favicon, size));
}
console.error(`Rendered plugin/icon.png and ${FAVICON_SIZES.length + 1} favicon files`);
