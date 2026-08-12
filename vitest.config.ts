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
        lines: 70,
        functions: 64,
        branches: 54,
        statements: 70,

        // The pure logic every other module depends on is held to a much higher
        // bar, because it is where a silent wrong answer would originate.
        'src/utils/transcript.ts': { lines: 95, functions: 95, branches: 85, statements: 95 },
        'src/utils/search-index.ts': { lines: 95, functions: 95, branches: 90, statements: 95 },
        'src/utils/validate.ts': { lines: 95, functions: 95, branches: 90, statements: 95 },
        'src/utils/preflight.ts': { lines: 95, functions: 95, branches: 90, statements: 95 },
        'src/utils/errors.ts': { lines: 90, functions: 90, branches: 85, statements: 90 },
        'src/utils/ytdlp.ts': { lines: 80, functions: 75, branches: 70, statements: 80 },
        'src/http.ts': { lines: 85, functions: 85, branches: 78, statements: 85 },
      },
    },
    testTimeout: 30000,
  },
});
