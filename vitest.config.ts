import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/perf/**/*.bench.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts', 'bin/**'],
      // ─── T8: Coverage thresholds (v3.1) ──────────────────────────────────
      // Thresholds are calibrated to current actuals so the gate passes on day
      // one, then ratcheted upward as each follow-up PR adds coverage.
      // Aspirational targets from PRD §6.6 are noted in TODO comments.
      // See docs/dev/coverage-targets.md for the baseline vs target table.
      thresholds: {
        // Overall baseline is 80.15% lines. Gate set to 80% (floor) so CI
        // passes immediately. TODO(T8-ratchet): raise to 88% incrementally.
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
        // ── Per-module gates ────────────────────────────────────────────────

        // registry: actual ~94.54% — maintain at 92% (conservative floor).
        'src/registry/**': { lines: 92, functions: 92, statements: 92 },

        // cache: actual ~88% — maintain.
        'src/cache/**': { lines: 88, functions: 80, statements: 88 },

        // reliability: actual ~97% — maintain at 90% (conservative floor).
        'src/reliability/**': { lines: 90, functions: 90, statements: 90 },

        // daemon: actual 83.95% — gate at 83%.
        // TODO(T8-daemon): raise to 92% after B1-B4 hardening tests land.
        'src/daemon/**': { lines: 83, functions: 75, statements: 83 },

        // runtime: actual aggregate 73.75% (pool/* drags it down).
        // Gate at 73% to match current baseline.
        // TODO(T8-runtime): raise to 88% after T2 memory-leak tests land.
        'src/runtime/**': { lines: 73, functions: 70, statements: 73 },

        // tokenize.ts: actual ~98.54% — maintain at 95%.
        'src/utils/tokenize.ts': { lines: 95, functions: 88, statements: 95 },

        // observability: actual ~87% — floor at 80%.
        'src/observability/**': { lines: 80, functions: 80, statements: 80 },

        // cli: actual aggregate 38.3% (wizard/ is 0%, commands/ is 68.59%).
        // Gate at 38% to match current baseline.
        // TODO(T8-cli): raise to 80% after CLI integration tests land.
        'src/cli/**': { lines: 38, functions: 38, statements: 38 },

        // metrics: actual ~75% — gate at 75%.
        // TODO(T8-metrics): raise to 92% after B13 test expansion.
        'src/metrics/**': { lines: 75, functions: 75, statements: 75 },
      },
    },
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});
