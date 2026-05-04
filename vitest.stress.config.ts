/**
 * Vitest configuration for the stress test suite.
 *
 * Invoked via:
 *   npm run test:stress       → PR-gate tier (10/50/100 concurrent)
 *   npm run test:stress:full  → Full STRESS=1 sweep (up to 1000 concurrent)
 *
 * Deliberately separate from vitest.config.ts so that:
 *   - `npm run test:run` (the default CI gate) never includes test/stress/
 *   - Stress tests can use longer per-test timeouts without affecting coverage
 *   - Coverage thresholds in vitest.config.ts are not impacted
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/stress/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // No coverage collection — stress tests measure latency, not line coverage.
    // Per-test timeout: 3 min default; individual tests override as needed.
    testTimeout: 180_000,
    hookTimeout: 30_000,
  },
});
