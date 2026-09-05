import { defineConfig } from 'vitest/config';

/**
 * The end-to-end lane: the built server, real MCP clients, real yt-dlp, the
 * real network. Opt-in (E2E=1), sequential so the suite never looks like a
 * scraper to YouTube, and never retried — a failure here is a finding.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    globalSetup: ['tests/e2e/setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    retry: 0,
  },
});
