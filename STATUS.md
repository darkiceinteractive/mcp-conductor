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
# Sprint STATUS

## Agent G — Phase 7: Observability + Replay

### START CHECKPOINT
- **Started:** 2026-05-04
- **Branch:** feature/v3-phase-7
- **Baseline:** 848 tests passing (1 skipped), 41 test files
- **Rebased onto:** origin/feature/v3-phase-0-1 ✓

### Scope
- `src/observability/cost-predictor.ts` — rolling per-(tool, args-shape-fingerprint) history, predicts tokens/latency
- `src/observability/hot-path.ts` — latency/volume profiler with rolling window and p99
- `src/observability/anomaly.ts` — 3σ outlier detection per (server, tool)
- `src/observability/replay.ts` — record/replay execute_code calls with .jsonl journals
- `src/observability/index.ts` — barrel export
- `src/cli/replay.ts` — CLI subcommand for replay
- 5 new MCP tools: predict_cost, get_hot_paths, record_session, stop_recording, replay_session
- Gateway instrumentation hooked into bridge callTool path

### PROGRESS
- [x] cost-predictor.ts — argsShapeFingerprint, CostPredictor, singleton
- [x] hot-path.ts — HotPathProfiler, rolling window, p99, deterministic ordering
- [x] anomaly.ts — Welford online algorithm, 3σ threshold, EventEmitter
- [x] replay.ts — JSONL journal, record/stop/replay, 1 GB rotation, divergence detection
- [x] observability/index.ts — barrel export
- [x] cli/replay.ts — replay <path>, --list, --at/--op/--with flags
- [x] mcp-server.ts integration (5 new tools: predict_cost, get_hot_paths, record_session, stop_recording, replay_session)
- [x] gateway instrumentation in callTool (hot-path + anomaly + cost-predictor)
- [x] test suite — 57 new tests, 905 total passing

### RESULT
READY-FOR-MERGE

PR: https://github.com/darkiceinteractive/mcp-conductor/pull/5

All 6 acceptance criteria met:
- Cost predictor within 30% after 10+ samples ✓
- Hot path deterministic ordering ✓
- Anomaly detector catches 10× outlier ✓
- Replay reproduces bit-identical (no mods) ✓
- Replay with op:skip bypasses call ✓
- Rotation at 1 GB ✓
# MCP Conductor v3 Sprint — STATUS

## Agent F — Phase 6: Daemon Mode + Multi-Agent Coordination

### Checkpoint: START
- **Date**: 2026-05-04
- **Branch**: feature/v3-phase-6
- **Baseline**: 848 tests passing (41 test files)
- **Rebased on**: origin/feature/v3-phase-0-1 (Agent A registry foundation) — clean
- **Status**: IN PROGRESS

### Scope
- `src/daemon/server.ts` — Unix socket + optional TCP daemon server
- `src/daemon/client.ts` — thin agent-side bridge (stdio to daemon)
- `src/daemon/discovery.ts` — Tailscale peer discovery
- `src/daemon/shared-kv.ts` — in-memory + disk-persistent KV with TTL
- `src/daemon/shared-lock.ts` — in-process mutex per key
- `src/daemon/index.ts` — daemon entry point / public exports
- `src/cli/daemon.ts` — daemon CLI subcommands (start/stop/status/logs)
- `test/unit/daemon/` — unit tests for all daemon modules
- `test/integration/daemon/` — two-agent integration scenarios

### Checkpoint: READY-FOR-MERGE
- **Date**: 2026-05-04
- **PR**: https://github.com/darkiceinteractive/mcp-conductor/pull/6
- **Status**: READY-FOR-MERGE
- **Tests**: 907 passed | 1 skipped | 0 failed (47 test files; baseline was 848/41)
- **Type-check**: clean (`npx tsc --noEmit`)

### Delivery summary

| File | Description |
|------|-------------|
| `src/daemon/shared-kv.ts` | In-memory + disk-persistent KV with TTL, 30 s sweep |
| `src/daemon/shared-lock.ts` | In-process promise-chain mutex, timeout, double-release safe |
| `src/daemon/server.ts` | Unix+TCP daemon, HMAC-SHA256 auth, per-client lock handles |
| `src/daemon/client.ts` | RPC bridge: kv/lock/broadcast/subscribe/callTool |
| `src/daemon/discovery.ts` | Tailscale CLI query, hostname→IP resolution, 10 s cache |
| `src/daemon/sandbox-api.ts` | `mcp.shared.*` API surface + no-op stub for standalone mode |
| `src/daemon/index.ts` | Public barrel export |
| `src/cli/daemon.ts` | `registerDaemonCommands(program)` for Agent I import; start/stop/status/logs |

### Acceptance criteria
- [x] Two agents share cache (agent B hits cache written by agent A)
- [x] Lock serialises 100 concurrent writers — max concurrency observed = 1
- [x] KV TTL expiry — expired entry invisible to both local and remote readers
- [x] Daemon survives agent crash — remaining clients unaffected
- [x] Tailscale discovery — hostname → IP resolution tested via CLI spy
- [x] Auth — wrong secret rejected with RPC 401 error
- [ ] src/bridge/pool.ts — backend connection pool
- [ ] src/runtime/pool/worker.ts — individual worker lifecycle
- [ ] src/runtime/pool/recycle.ts — recycle policy
- [ ] src/runtime/pool/worker-pool.ts — warm Deno worker management
- [ ] src/runtime/pool/index.ts — public exports
- [ ] Config schema extensions (ConnectionPoolConfig, WorkerPoolConfig)
- [ ] Tests: worker-pool.test.ts, recycle.test.ts, pool.test.ts (bridge)
- [ ] PR created

## Acceptance Targets
- [x] Worker pool pre-warmed at startup (50ms bootstrap delay, first job hits warm worker)
- [x] Worker recycle does not interrupt in-flight jobs (replacement spawned before termination)
- [x] 1000-job memory stability test passes (recycle bookkeeping loop, no leaks)
- [x] Connection pool limits respected (max blocks, timeout rejects)
- [x] Backend crash → respawn within one event-loop tick
- [x] preloadHelpers[] list accepted by worker bootstrap (Phase 5 plug-in point)

## READY-FOR-MERGE
### Files to deliver
- `src/server/passthrough-registrar.ts` (NEW)
- `src/registry/built-in-recommendations.ts` (NEW)
- `src/server/mcp-server.ts` (MODIFY — wire `registerPassthroughTools()` after `registry.refresh()`)
- `test/unit/passthrough-registrar.test.ts` (NEW)

---
