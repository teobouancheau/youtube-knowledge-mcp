import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['node_modules', 'dist', '**/*.test.ts', '**/*.config.*'],
      thresholds: {
        // Global floor. These are a ratchet, not a target: raise them as
        // coverage improves, never lower them to make a build pass.
        //
        // What is left uncovered is deliberate and small: the process entry
        // point (exercised out of process by scripts/smoke.mjs), a handful of
        // defensive guards against internal states that cannot occur, and two
        // error handlers that need a transport to fail mid-response.
        lines: 99,
        functions: 97,
        branches: 90,
        statements: 98,

        // The pure logic every other module depends on is held higher still,
        // because it is where a silent wrong answer would originate.
        'src/utils/transcript*.ts': { lines: 100, functions: 100, branches: 95, statements: 98 },
        'src/utils/pattern.ts': { lines: 100, functions: 100, branches: 95, statements: 98 },
        'src/utils/search-index.ts': { lines: 100, functions: 100, branches: 92, statements: 97 },
        'src/utils/validate*.ts': { lines: 100, functions: 100, branches: 93, statements: 100 },
        'src/utils/env.ts': { lines: 100, functions: 100, branches: 93, statements: 100 },
        'src/utils/guard.ts': { lines: 100, functions: 100, branches: 90, statements: 100 },
        'src/utils/ytdlp-env.ts': { lines: 100, functions: 100, branches: 93, statements: 100 },
        'src/utils/json-file.ts': { lines: 100, functions: 100, branches: 93, statements: 100 },
        'src/utils/preflight.ts': { lines: 100, functions: 100, branches: 93, statements: 100 },
        'src/utils/errors.ts': { lines: 100, functions: 100, branches: 95, statements: 100 },
        'src/utils/youtube*.ts': { lines: 100, functions: 97, branches: 93, statements: 98 },
        'src/utils/transcript-cache.ts': {
          lines: 100,
          functions: 97,
          branches: 93,
          statements: 98,
        },
        'src/utils/caption-probe.ts': { lines: 100, functions: 100, branches: 93, statements: 98 },
        'src/utils/ytdlp.ts': { lines: 100, functions: 100, branches: 93, statements: 97 },
        'src/utils/storage.ts': { lines: 100, functions: 96, branches: 91, statements: 99 },
        'src/tools': { lines: 100, functions: 100, branches: 84, statements: 99 },
        'src/http.ts': { lines: 97, functions: 91, branches: 88, statements: 95 },
        'src/http/**': { lines: 97, functions: 91, branches: 88, statements: 95 },
      },
    },
    testTimeout: 30000,
  },
});
