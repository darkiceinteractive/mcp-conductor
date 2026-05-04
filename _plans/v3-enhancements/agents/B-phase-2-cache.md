# Agent B — PRD Phase 2 Cache layer

You build the three-tier cache (LRU + disk CBOR + delta encoding) on top of Agent A's registry.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/B-phase-2
git branch --show-current  # feature/v3-phase-2
git fetch origin && git rebase origin/feature/v3-phase-0-1   # pick up A's foundation
npm install
npm run test:run  # baseline must be green
```

Read `_plans/v3-enhancements/MCP-Conductor-v3-PRD.md` §5 Phase 2 (lines ~357–540).

Append start checkpoint to `_plans/v3-enhancements/STATUS.md` under Agent B.

## Scope

Build everything in `src/cache/` per PRD §5 Phase 2 file list and public API. **Use ToolRegistry annotations to drive TTL policy** — `ToolDefinition.cacheable` and `ToolDefinition.cacheTtl` are the registry-level overrides; the per-tool policy table in PRD is the default.

Cache key derivation MUST come from registry `inputSchema` (use `validator.ts`'s normalisation), not from raw args object — this guarantees stable hashes across runs.

Important wiring point: bridge `callTool()` invokes cache **before** reliability gateway (Agent C). Order: cache check → cache miss → reliability gateway → backend. Cache hit short-circuits everything.

## Acceptance

PRD §5 Phase 2 "Acceptance criteria" + this addition:
- Cache invalidation on registry `tool-updated` event (when an upstream schema changes, related cache entries are flushed).

## Commit pattern

```
feat(v3-phase-2): in-memory LRU + content-addressed key derivation
feat(v3-phase-2): CBOR-encoded disk cache with rotation
feat(v3-phase-2): delta encoding for repeat queries
feat(v3-phase-2): TTL policy table + per-server overrides
feat(v3-phase-2): wire CacheLayer into bridge callTool path
test(v3-phase-2): full lru/disk/key/delta/cache test suites
```

## PR

`gh pr create --base feature/v3 --title "v3 Phase 2: Cache layer (LRU + CBOR disk + delta)"`. Update STATUS.md `READY-FOR-MERGE`.

## When to stop

After PR open, CI green, STATUS.md updated. Don't touch any other phase's files.
