# Coverage Targets — v3.1

This document tracks the coverage baseline measured on the `test/v3.1-C-perf-and-coverage`
branch and the per-module aspirational targets from PRD §6.6.

Thresholds are enforced via `vitest.config.ts` `coverage.thresholds`. They are intentionally
set to **current actuals** on day one, then ratcheted upward as follow-up PRs add tests.

## Baseline snapshot (2026-05-04)

Overall coverage measured against `src/**/*.ts` (excluding `src/index.ts`, `bin/**`, `*.d.ts`).

| Module glob | Actual lines% | Actual functions% | Actual branches% | Current gate (lines) | PRD §6.6 target | Status |
|---|---|---|---|---|---|---|
| **All files** | 80.17% | 82.76% | 91.53% | 80% | 88% | TODO — ratchet |
| `src/registry/**` | 94.54% | 97.29% | 91.59% | 92% | maintain | ✓ at target |
| `src/cache/**` | ~88% | ~80% | ~75% | 88% | maintain | ✓ at target |
| `src/reliability/**` | 97.97% | 100% | 89.85% | 90% | maintain | ✓ at target |
| `src/daemon/**` | 83.95% | 82.5% | 89.87% | 83% | 92% | TODO — ratchet after B1-B4 |
| `src/runtime/**` | 73.75%* | 70%* | — | 73% | 88% | TODO — ratchet after T2 |
| `src/utils/tokenize.ts` | 98.54% | 90.24% | 100% | 95% | maintain | ✓ at target |
| `src/observability/**` | ~87% | ~87% | — | 80% | maintain | ✓ at target |
| `src/cli/**` | 38.3%** | 38%** | — | 38% | 80% | TODO — ratchet after T3 |
| `src/metrics/**` | ~75% | ~75% | — | 75% | 92% | TODO — ratchet after B13 |

\* `src/runtime/**` aggregate is pulled down by `src/runtime/pool/worker.ts` (14.2%) and
`src/runtime/pool/worker-pool.ts` (53.65%). Covered in T2 memory-leak suite.

\** `src/cli/**` aggregate is pulled down by `src/cli/wizard/` (0%) and `src/cli/` index files (0%).
Covered in T3 security + CLI integration tests.

## Ratchet plan

| PR / block | Coverage action |
|---|---|
| B1-B4 (daemon hardening) | Raise `src/daemon/**` gate to 92% |
| T2 (memory-leak suite) | Raise `src/runtime/**` gate to 85%+ |
| T3 (security suite) | Raise `src/cli/**` gate to 70%+ |
| B13 test expansion | Raise `src/metrics/**` gate to 92% |
| T8-ratchet sprint | Raise overall gate from 80% → 88% |

## How to update this document

After each coverage-raising PR:

1. Run `npm run test:coverage:check` and note the new actuals.
2. Bump the gate in `vitest.config.ts` to match new actual (or slightly below).
3. Update the table above with the new actual and gate values.
4. Update the `Status` column.
