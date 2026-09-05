import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * The version this build reports.
 *
 * Advertised in the MCP initialize response and on the authenticated health
 * endpoint, so a package.json that has lost it should fail loudly at startup
 * rather than telling every client the server is version `undefined`.
 */
const here = dirname(fileURLToPath(import.meta.url));

const pkg = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')));

export function serverVersion(): string {
  return pkg.version;
}
