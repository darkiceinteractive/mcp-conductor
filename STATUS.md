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

- [ ] src/bridge/pool.ts — backend connection pool
- [ ] src/runtime/pool/worker.ts — individual worker lifecycle
- [ ] src/runtime/pool/recycle.ts — recycle policy
- [ ] src/runtime/pool/worker-pool.ts — warm Deno worker management
- [ ] src/runtime/pool/index.ts — public exports
- [ ] Config schema extensions (ConnectionPoolConfig, WorkerPoolConfig)
- [ ] Tests: worker-pool.test.ts, recycle.test.ts, pool.test.ts (bridge)
- [ ] PR created

## Acceptance Targets
- First execute_code <30ms (warm worker)
- Subsequent <10ms median
- 1000-job memory stability
- Worker recycle does not interrupt in-flight jobs
