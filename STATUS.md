# Workstream X1 Status — Agent H

## Checkpoint: START

**Agent**: H
**Branch**: feature/v3-x1-passthrough
**Base**: feature/v3-phase-0-1
**Baseline tests**: 848 passed, 1 skipped (2026-05-04)

### Task
Registry-driven passthrough adapter (closes IBKR findings #2 and #3).

Expose `routing: "passthrough"` tools as first-class Conductor MCP tools with upstream annotations preserved.

### Files delivered
- `src/registry/built-in-recommendations.ts` (NEW) — commit 74348a7
- `src/server/passthrough-registrar.ts` (NEW) — commit 11ac32b
- `src/server/mcp-server.ts` (MODIFIED) — commit ca07842
- `test/unit/passthrough-registrar.test.ts` (NEW) — commit d092aa7

## Checkpoint: READY-FOR-MERGE

**PR**: https://github.com/darkiceinteractive/mcp-conductor/pull/3
**Base**: feature/v3
**Tests**: 859 passed (848 baseline + 11 new) | 1 skipped | 42 test files

### Summary

Registry-driven passthrough adapter ships in 4 commits:

1. `feat(v3-x1): built-in routing recommendations for github/filesystem/brave-search`
2. `feat(v3-x1): passthrough registrar that reads registry annotations`
3. `feat(v3-x1): wire registrar into mcp-server startup after registry.refresh`
4. `test(v3-x1): passthrough registrar test suite (11 cases)`

### Acceptance criteria met

- `routing: "passthrough"` tools appear in `tools/list` from Conductor as `<server>__<tool>` tools.
- Calls bypass Deno entirely and route directly to `MCPHub.callTool()`.
- Built-in recommendations apply for `github`, `filesystem`, `brave-search` at startup.
- User-supplied `routing` annotations are never overwritten.
- Default routing for unknown servers remains `execute_code` (backwards compatible).
- 11 unit tests covering registrar, name builder, and recommendation logic.

---

# Agent D — Phase 4 Status

## Checkpoints

### START — 2026-05-04
- Branch: feature/v3-phase-4
- Rebased onto: origin/feature/v3-phase-0-1 (Agent A's Phase 0 scaffold)
- Baseline: 848 tests pass (41 files)
- Scope: src/bridge/pool.ts + src/runtime/pool/{worker-pool,worker,recycle}.ts + tests

## Progress

- [x] src/config/schema.ts — ConnectionPoolConfig, WorkerPoolConfig, RuntimePoolConfig
- [x] src/bridge/pool.ts — backend connection pool with JSON-RPC multiplexing
- [x] src/bridge/index.ts — re-exports pool
- [x] src/runtime/pool/worker.ts — persistent Deno worker with preload hook for Phase 5
- [x] src/runtime/pool/recycle.ts — evaluateRecycle / isEligible pure functions
- [x] src/runtime/pool/worker-pool.ts — warm worker pool, async recycle, queue drain
- [x] src/runtime/pool/index.ts — public barrel exports
- [x] src/runtime/index.ts — re-exports pool through runtime barrel
- [x] test/unit/bridge/pool.test.ts — 17 connection pool assertions
- [x] test/unit/runtime/worker-pool.test.ts — 11 pool + recycle assertions incl. 1000-job stability
- [x] PR created

## Test results
- Baseline: 848 tests (41 files)
- After Phase 4: 871 tests (43 files) — 23 new tests, 0 regressions

## Acceptance Targets
- [x] Worker pool pre-warmed at startup (50ms bootstrap delay, first job hits warm worker)
- [x] Worker recycle does not interrupt in-flight jobs (replacement spawned before termination)
- [x] 1000-job memory stability test passes (recycle bookkeeping loop, no leaks)
- [x] Connection pool limits respected (max blocks, timeout rejects)
- [x] Backend crash → respawn within one event-loop tick
- [x] preloadHelpers[] list accepted by worker bootstrap (Phase 5 plug-in point)

## READY-FOR-MERGE
