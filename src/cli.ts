#!/usr/bin/env node
/**
 * The executable entry point, separate from the module that builds the server.
 *
 * `index.ts` is imported by the test suite, so it must not start a transport on
 * import. It used to guard against that by comparing `import.meta.url` with
 * `process.argv[1]`, which is false whenever the process is launched through a
 * symlink: npm and npx install the `bin` as a link in `node_modules/.bin`, and
 * Node reports the link in `argv[1]` while resolving `import.meta.url` to the
 * real file. `main()` then never ran, and the server exited 0 without output.
 *
 * A dedicated entry has nothing to detect: this file exists only to be run.
 */
import { main } from './index.js';

main().catch((error: unknown) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
