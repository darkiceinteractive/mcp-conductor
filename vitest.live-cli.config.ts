import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/live-cli/**/*.test.ts'],
    // Soak tests are gated by SOAK=1 env var internally, but excluded
    // from the default pattern to keep normal runs fast
    exclude: [
      'node_modules',
      'dist',
    ],
    testTimeout: 300_000,   // 5 minutes per test
    hookTimeout: 120_000,   // 2 minutes for beforeAll (hub init can be slow)
    pool: 'forks',          // isolate test file processes
    poolOptions: {
      forks: {
        // singleFork keeps all test files in one worker process (sequential
        // execution), which avoids overwhelming the system with many
        // concurrent conductor instances. Set to false to enable concurrent
        // file-level parallelism (up to minForks/maxForks).
        singleFork: true,
      },
    },
    reporter: ['verbose'],
  },
});
