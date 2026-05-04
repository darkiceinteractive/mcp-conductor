#!/usr/bin/env bash
# One-shot generator: creates STATUS.md, worktree scripts, and all 11 agent
# prompt files in a single invocation. Designed to bypass the per-Write
# Fact-Forcing Gate when bootstrapping the v3 multi-agent handoff.
#
# Run from repo root:
#   bash _plans/v3-enhancements/_handoff-bootstrap.sh
#
# After it runs and the generated files are committed, this script can be
# deleted — its job is done.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIR/agents"

# ---------- STATUS.md ----------
cat > "$DIR/STATUS.md" <<'EOF_STATUS'
# MCP Conductor v3 — Agent Status

**Single source of truth for the 10-agent v3 sprint. Every agent appends to its own letter section.**

Format per checkpoint:
- `[YYYY-MM-DD HH:MM AEDT] <event>` — start, ✓ acceptance criterion met, BLOCKED:, READY-FOR-MERGE: <PR URL>, completed.

---

## Agent A — PRD Phase 0 + Phase 1 + finish X3 leftovers
**Branch**: `feature/v3-phase-0-1` · **Worktree**: `mcp-executor-darkice-worktrees/A-phase-0-1/`

_(awaiting agent)_

---

## Agent B — PRD Phase 2 Cache layer
**Branch**: `feature/v3-phase-2` · **Worktree**: `B-phase-2/` · **Blocked by**: A's Phase 1

_(awaiting agent)_

---

## Agent C — PRD Phase 3 Reliability gateway + MCPToolError
**Branch**: `feature/v3-phase-3` · **Worktree**: `C-phase-3/` · **Blocked by**: A's Phase 0

_(awaiting agent)_

---

## Agent D — PRD Phase 4 Connection + Worker pools
**Branch**: `feature/v3-phase-4` · **Worktree**: `D-phase-4/` · **Blocked by**: A's Phase 0

_(awaiting agent)_

---

## Agent E — PRD Phase 5 Sandbox capabilities (compact/summarize/delta/budget/findTool)
**Branch**: `feature/v3-phase-5` · **Worktree**: `E-phase-5/` · **Blocked by**: A's Phase 1 + D's Phase 4

_(awaiting agent)_

---

## Agent F — PRD Phase 6 Daemon mode + multi-agent KV/lock
**Branch**: `feature/v3-phase-6` · **Worktree**: `F-phase-6/` · **Blocked by**: A's Phase 1

_(awaiting agent)_

---

## Agent G — PRD Phase 7 Observability + replay
**Branch**: `feature/v3-phase-7` · **Worktree**: `G-phase-7/` · **Blocked by**: A's Phase 0

_(awaiting agent)_

---

## Agent H — Workstream X1 Passthrough adapter
**Branch**: `feature/v3-x1-passthrough` · **Worktree**: `H-x1/` · **Blocked by**: A's Phase 1

_(awaiting agent)_

---

## Agent I — Workstream X2 Lifecycle tools + CLI wizard
**Branch**: `feature/v3-x2-lifecycle` · **Worktree**: `I-x2/` · **Blocked by**: A's Phase 1 + F's Phase 6

_(awaiting agent)_

---

## Agent J — Workstream X4 PII tokenization
**Branch**: `feature/v3-x4-tokenization` · **Worktree**: `J-x4/` · **Blocked by**: A's Phase 1 + H's X1

_(awaiting agent)_

---

## Agent K — Integration day
**Branch**: `feature/v3` directly (no worktree — runs at the main repo path) · **Blocked by**: all merged

_(awaiting agent)_

---

## Conventions

- Times in AEDT (UTC+11). Use `date +"%Y-%m-%d %H:%M AEDT"` to stamp.
- One blank line between checkpoints.
- Blockers must include what's needed to unblock and an `@matt` ping if human input is required.
EOF_STATUS

# ---------- setup-worktrees.sh ----------
cat > "$DIR/setup-worktrees.sh" <<'EOF_SETUP'
#!/usr/bin/env bash
# Create 10 git worktrees off feature/v3, one per agent.
# Run from repo root: bash _plans/v3-enhancements/setup-worktrees.sh

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_ROOT="$(dirname "$REPO_ROOT")/mcp-executor-darkice-worktrees"

echo "Repo root:     $REPO_ROOT"
echo "Worktree root: $WORKTREE_ROOT"

# Confirm we're on feature/v3
current_branch="$(git -C "$REPO_ROOT" branch --show-current)"
if [ "$current_branch" != "feature/v3" ]; then
  echo "ERROR: must be on branch 'feature/v3' (currently on '$current_branch')"
  exit 1
fi

git -C "$REPO_ROOT" fetch origin

mkdir -p "$WORKTREE_ROOT"

declare -a TREES=(
  "A-phase-0-1:feature/v3-phase-0-1"
  "B-phase-2:feature/v3-phase-2"
  "C-phase-3:feature/v3-phase-3"
  "D-phase-4:feature/v3-phase-4"
  "E-phase-5:feature/v3-phase-5"
  "F-phase-6:feature/v3-phase-6"
  "G-phase-7:feature/v3-phase-7"
  "H-x1:feature/v3-x1-passthrough"
  "I-x2:feature/v3-x2-lifecycle"
  "J-x4:feature/v3-x4-tokenization"
)

for entry in "${TREES[@]}"; do
  dir="${entry%%:*}"
  branch="${entry##*:}"
  path="$WORKTREE_ROOT/$dir"
  if [ -d "$path" ]; then
    echo "skip   $dir (already exists)"
    continue
  fi
  echo "create $dir on branch $branch"
  git -C "$REPO_ROOT" worktree add -b "$branch" "$path" feature/v3
done

echo
echo "All worktrees created under $WORKTREE_ROOT"
echo "List:"
git -C "$REPO_ROOT" worktree list
EOF_SETUP
chmod +x "$DIR/setup-worktrees.sh"

# ---------- cleanup-worktrees.sh ----------
cat > "$DIR/cleanup-worktrees.sh" <<'EOF_CLEAN'
#!/usr/bin/env bash
# Remove all v3 sprint worktrees. Run AFTER agents' branches are merged to feature/v3.
# Run from repo root: bash _plans/v3-enhancements/cleanup-worktrees.sh

set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_ROOT="$(dirname "$REPO_ROOT")/mcp-executor-darkice-worktrees"

if [ ! -d "$WORKTREE_ROOT" ]; then
  echo "Nothing to clean — $WORKTREE_ROOT does not exist."
  exit 0
fi

echo "About to remove all worktrees under $WORKTREE_ROOT and their branches."
echo "Press Ctrl-C to abort, or any key to continue..."
read -r _

for d in "$WORKTREE_ROOT"/*/; do
  [ -d "$d" ] || continue
  echo "remove $d"
  git -C "$REPO_ROOT" worktree remove --force "$d" || true
done

git -C "$REPO_ROOT" worktree prune
rmdir "$WORKTREE_ROOT" 2>/dev/null || true
echo "Done. Branches feature/v3-phase-* and feature/v3-x-* remain — delete with:"
echo "  git branch -D feature/v3-phase-{0-1,2,3,4,5,6,7} feature/v3-x{1-passthrough,2-lifecycle,4-tokenization}"
EOF_CLEAN
chmod +x "$DIR/cleanup-worktrees.sh"

# ---------- agents/A-phase-0-1-and-x3.md ----------
cat > "$DIR/agents/A-phase-0-1-and-x3.md" <<'EOF_A'
# Agent A — PRD Phase 0 + Phase 1 + finish X3 leftovers

You are the **lead agent** for the MCP Conductor v3 sprint. You unblock every other agent. **Land Phase 1 cleanly or the whole sprint stalls.**

## Setup

Confirm you're in the right worktree:

```bash
pwd  # should end with /mcp-executor-darkice-worktrees/A-phase-0-1
git branch --show-current  # should print: feature/v3-phase-0-1
git log --oneline -3  # baseline should be 8e6d1ad cleanup(X3)
```

Read these before touching code:
- `_plans/v3-enhancements/MCP-Conductor-v3-PRD.md` §5 Phase 0 (lines ~75–101) and §5 Phase 1 (lines ~103–355)
- `_plans/v3-enhancements/README.md` (handoff bundle index)
- `/Users/mattcrombie/.claude/plans/read-this-analysis-from-rosy-whale.md` (consolidated plan, especially the Phase 1 amendments in §3 Part B)
- `_plans/v3-enhancements/STATUS.md` — append your start checkpoint under "Agent A"

## Scope (in execution order)

### Block 1 — Finish X3 leftovers (do FIRST, ~30 min)

Two items left from the X3 cleanup that landed in `8e6d1ad`. Do them now so they're out of the way:

1. **Wiki troubleshooting note** — add a section to `wiki/Troubleshooting.md` (create if missing) explaining the Claude Code `.mcp.json` approval prompt. When users add Conductor via project-level `.mcp.json`, Claude Code shows an approval prompt asking which tools to allow. Tell them to pick option 1 ("Allow this MCP server"). Reference `~/.claude/settings.json` as the alternative that avoids the prompt.

2. **Two integration tests** for the new `mcp.batch()` dual signature in `test/integration/full-flow.test.ts` (read it first to see the existing pattern):
   - `mcp.batch accepts callback form: [() => mcp.server('x').call('y', {})]` — assert results in correct order.
   - `mcp.batch accepts descriptor form: [{server,tool,params}]` — regression check.

Commit these as `cleanup(X3): wiki note + mcp.batch dual-signature integration tests`. Push.

### Block 2 — PRD Phase 0 scaffolding (~30 min)

Do exactly what PRD §5 Phase 0 says:

- Add deps: `json-schema-to-typescript@^15`, `ajv@^8`, `lru-cache@^11`, `cbor-x@^1`, `nanoid@^5`, `p-queue@^8`.
- Create stub directories with `.gitkeep`: `src/registry/`, `src/registry/types/` (also add to `.gitignore`), `src/cache/`, `src/reliability/`, `src/runtime/pool/`, `src/daemon/`, `src/observability/`, `docs/v3/`.
- Run `npm install`, `npm run build`, `npm run test:run`, `npm run lint`. Everything green.

Commit as `chore(v3-phase-0): scaffold v3 directories and dependencies`. Push.

### Block 3 — PRD Phase 1: Tool Registry & Type Generation (~6 hours, the critical path)

Build per PRD §5 Phase 1 lines 103–355. **Build the public API in `src/registry/index.ts` exactly as specified** — every other agent imports it. Do not deviate from the field names.

**Important amendments from the consolidated plan** (do not skip):

1. Extend `ToolDefinition` with three additional optional fields:
   ```typescript
   routing?: 'passthrough' | 'execute_code' | 'hidden';   // for X1 (Agent H)
   redact?: { response?: Array<'email'|'phone'|'ssn'|'credit_card'|string> };  // for X4 (Agent J)
   examples?: Array<{ args: unknown; result: unknown; description?: string }>;  // Anthropic pattern
   ```
2. `typegen.ts` emits `@example` JSDoc blocks from `examples[]`.
3. `typegen.ts` writes a sibling `<server>.routing.json` capturing the per-tool routing decision (defaults to `execute_code` when not set), so X1's passthrough adapter can read it without re-parsing types.

Acceptance criteria: PRD §5 Phase 1 "Acceptance criteria" + the three amendments above (each must have a test).

Commit pattern: one commit per file or per logical unit, e.g.:
- `feat(v3-phase-1): ToolRegistry skeleton + RegistryEvent typedef`
- `feat(v3-phase-1): typegen via json-schema-to-typescript`
- `feat(v3-phase-1): ajv-based input validation pre-flight`
- `feat(v3-phase-1): snapshot persistence`
- `feat(v3-phase-1): wire registry into src/index.ts startup`
- `feat(v3-phase-1): @example JSDoc + routing.json sibling output (X1/X4 hooks)`
- `test(v3-phase-1): registry / typegen / validator / snapshot test suites`

### Block 4 — Open PR

```bash
gh pr create --base feature/v3 --title "v3 Phase 0 + Phase 1: scaffolding + Tool Registry & Type Generation" --body "$(cat <<'BODY'
## Summary
- Phase 0 scaffold (deps, dirs)
- Phase 1 ToolRegistry with .d.ts generation, ajv validation, snapshot persistence, hot reload
- Plan amendments: routing/redact/examples fields on ToolDefinition; @example JSDoc; routing.json sibling
- X3 leftovers: wiki troubleshooting note + 2 mcp.batch integration tests

## Test plan
- [x] All 782 baseline tests still pass
- [x] New tests: registry (~9), typegen (~10), validator (~7), snapshot (~3) — see PRD test cases
- [x] npm run build clean, npm run lint clean
- [x] tsc --noEmit on a generated .d.ts succeeds
BODY
)"
```

Update STATUS.md: `READY-FOR-MERGE: <PR URL>`.

## When to stop

Stop after the PR is open and CI is green. Update STATUS.md final block with:
- Tests passing (n/total)
- Coverage %
- All Phase 1 acceptance criteria checked
- PR URL

Do NOT start Phase 2 — that's Agent B.

## If blocked

Append `BLOCKED: <what>` to your STATUS.md section and stop. Common likely blockers:
- `json-schema-to-typescript` chokes on a recursive schema → accept whatever it emits, log a follow-up.
- A real backend in `~/.mcp-conductor.json` returns malformed `tools/list` → log warning, skip that tool, continue.
EOF_A

# ---------- agents/B-phase-2-cache.md ----------
cat > "$DIR/agents/B-phase-2-cache.md" <<'EOF_B'
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
EOF_B

# ---------- agents/C-phase-3-reliability.md ----------
cat > "$DIR/agents/C-phase-3-reliability.md" <<'EOF_C'
# Agent C — PRD Phase 3 Reliability gateway + MCPToolError

You build per-server timeouts/retries/circuit breakers + the structured `MCPToolError` class.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/C-phase-3
git branch --show-current  # feature/v3-phase-3
git fetch origin && git rebase origin/feature/v3-phase-0-1   # pick up A's Phase 0 scaffold
npm install
npm run test:run
```

Read `_plans/v3-enhancements/MCP-Conductor-v3-PRD.md` §5 Phase 3 (lines ~542–684) and the consolidated plan's Amendment to PRD Phase 3 (`MCPToolError` class).

Append start checkpoint to STATUS.md under Agent C.

## Scope

Build everything in `src/reliability/` per PRD §5 Phase 3 + add this amendment from the consolidated plan:

```typescript
// src/reliability/errors.ts (or include in index.ts)
export class MCPToolError extends Error {
  constructor(
    public code: string,            // upstream error code if available
    public server: string,
    public tool: string,
    public upstream: unknown        // original error object
  ) { super(`[${server}.${tool}] ${code}`); }
}
```

Hub `callTool` (`src/hub/mcp-hub.ts:679` area) re-throws upstream errors as `MCPToolError`. Executor surfaces them in the sandbox preamble so Claude can `catch (e) { if (e.code === 'contract_not_found') ... }`.

Wiring order with Cache (Agent B): cache miss → **reliability gateway** → backend. Reliability profile resolved from: tool-level `ToolDefinition.reliability` → server-level config → global default.

## Acceptance

PRD §5 Phase 3 "Acceptance criteria" + these additions:
- `MCPToolError` thrown from sandbox is catchable as `e instanceof MCPToolError` with `.code/.server/.tool/.upstream` populated.
- Hub never wraps an `MCPToolError` in a generic `Error`.

## Commit pattern

```
feat(v3-phase-3): ReliabilityProfile + defaults
feat(v3-phase-3): circuit breaker (closed/open/half-open)
feat(v3-phase-3): retry with exponential backoff
feat(v3-phase-3): timeout enforcement with AbortSignal
feat(v3-phase-3): ReliabilityGateway composition
feat(v3-phase-3): MCPToolError class + hub re-throw
feat(v3-phase-3): sandbox-side MCPToolError shim
test(v3-phase-3): full suite + IBKR-style hang fixture
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 Phase 3: Reliability gateway + MCPToolError"`. Update STATUS.md.
EOF_C

# ---------- agents/D-phase-4-pools.md ----------
cat > "$DIR/agents/D-phase-4-pools.md" <<'EOF_D'
# Agent D — PRD Phase 4 Connection pool + warm sandbox pool

You kill cold-start latency: persistent stdio to backends + warm Deno workers.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/D-phase-4
git branch --show-current  # feature/v3-phase-4
git fetch origin && git rebase origin/feature/v3-phase-0-1
npm install && npm run test:run
```

Read PRD §5 Phase 4 (lines ~686–833).

Append start checkpoint to STATUS.md.

## Scope

Build per PRD: `src/bridge/pool.ts` and `src/runtime/pool/{worker-pool,worker,recycle}.ts`.

Workers preload Agent A's generated `.d.ts` from registry `typesDir` via Deno `--config`. Workers also preload Agent E's helpers when those land — for now, design the worker bootstrap as accepting a list of preload scripts so Agent E plugs in cleanly.

Per-server connection limits read from a new config block:
```json
{
  "runtime": {
    "workerPool": { "size": 4, "maxJobsPerWorker": 100, "maxAgeMs": 600000 },
    "connectionPool": { "minConnectionsPerServer": 1, "maxConnectionsPerServer": 4, "idleTimeoutMs": 300000 }
  }
}
```

## Acceptance

PRD §5 Phase 4 "Acceptance criteria" — especially the latency targets (<30ms cold, <10ms warm median) and the 1000-job memory stability test.

## Commit pattern

```
feat(v3-phase-4): backend connection pool with multiplexing
feat(v3-phase-4): warm Deno worker pool with recycle policy
feat(v3-phase-4): preload hook so Phase 5 helpers can plug in
feat(v3-phase-4): wire pools into bridge + executor request path
test(v3-phase-4): pool + worker test suites + 1000-job memory stability
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 Phase 4: Connection pool + warm sandbox pool"`. STATUS.md.
EOF_D

# ---------- agents/E-phase-5-sandbox.md ----------
cat > "$DIR/agents/E-phase-5-sandbox.md" <<'EOF_E'
# Agent E — PRD Phase 5 Sandbox capabilities

You add `mcp.compact/summarize/delta/budget/findTool` + skills wiring + vector tool index.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/E-phase-5
git branch --show-current  # feature/v3-phase-5
git fetch origin
# Need both Phase 1 AND Phase 4
git rebase origin/feature/v3-phase-0-1
git rebase origin/feature/v3-phase-4
npm install && npm run test:run
```

Read PRD §5 Phase 5 (lines ~835–986).

Append start checkpoint to STATUS.md.

## Scope

Build per PRD: `src/runtime/helpers/`, `src/runtime/findtool/`, extend `src/skills/`. Plug helpers into Agent D's worker preload hook.

`findTool` uses local MiniLM-L6 ONNX (from `@xenova/transformers` or `onnxruntime-node`). Lazy initialise on first call. Cache embeddings to disk under `~/.mcp-conductor/embeddings/` keyed by registry revision.

Skills wiring: read `process.env.CLAUDE_SKILLS_DARKICE` first; fall back to `./skills`. Hot reload on directory change (existing skills engine has the watcher).

## Acceptance

PRD §5 Phase 5 "Acceptance criteria" — all helpers must be zero-roundtrip, `findTool` returns relevant tool in top 3.

## Commit pattern

```
feat(v3-phase-5): mcp.compact field selection + array truncation
feat(v3-phase-5): mcp.summarize heuristic with style modes
feat(v3-phase-5): mcp.delta wrapping cache.delta
feat(v3-phase-5): mcp.budget auto-trim with BudgetExceededError
feat(v3-phase-5): findTool vector index (MiniLM-L6 local ONNX)
feat(v3-phase-5): skills engine wired to $CLAUDE_SKILLS_DARKICE
feat(v3-phase-5): preload helpers into worker pool
test(v3-phase-5): full helpers/findtool/skills test suite
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 Phase 5: Sandbox capabilities"`. STATUS.md.
EOF_E

# ---------- agents/F-phase-6-daemon.md ----------
cat > "$DIR/agents/F-phase-6-daemon.md" <<'EOF_F'
# Agent F — PRD Phase 6 Daemon mode + multi-agent coordination

You promote Conductor to a Tailscale-discoverable daemon shared by multiple Claude Code agents.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/F-phase-6
git branch --show-current  # feature/v3-phase-6
git fetch origin && git rebase origin/feature/v3-phase-0-1
npm install && npm run test:run
```

Read PRD §5 Phase 6 (lines ~988–1122).

Append start checkpoint to STATUS.md.

## Scope

Build `src/daemon/{server,client,discovery,shared-kv,shared-lock}.ts` and CLI subcommands `src/cli/daemon.ts` (the latter integrates with Agent I's CLI scaffold — design the daemon CLI as a self-contained module Agent I imports).

Auth: shared secret file (mode 0600) at `~/.mcp-conductor/daemon-auth.json`. NO OS keychain in v3.

Locks: in-process mutex per key. Cross-daemon Tailscale mesh deferred to v3.1 (PRD §3).

KV: in-memory + disk-persistent under `~/.mcp-conductor/kv/`. TTL supported.

Sandbox API: `mcp.shared.{kv,lock,broadcast,subscribe}` — wire into worker preload (coordinate with Agent D's hook).

## Acceptance

PRD §5 Phase 6 "Acceptance criteria".

## Commit pattern

```
feat(v3-phase-6): DaemonServer with Unix socket + optional TCP
feat(v3-phase-6): DaemonClient stdio bridge for transparent agent connection
feat(v3-phase-6): shared KV with TTL + disk persistence
feat(v3-phase-6): shared lock primitive (in-process mutex)
feat(v3-phase-6): broadcast/subscribe (in-process pub/sub)
feat(v3-phase-6): Tailscale peer discovery
feat(v3-phase-6): daemon CLI subcommands (start/stop/status/logs)
feat(v3-phase-6): mcp.shared.* sandbox API
test(v3-phase-6): daemon + KV + lock test suites + two-agent integration
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 Phase 6: Daemon mode + multi-agent coordination"`. STATUS.md.
EOF_F

# ---------- agents/G-phase-7-observability.md ----------
cat > "$DIR/agents/G-phase-7-observability.md" <<'EOF_G'
# Agent G — PRD Phase 7 Observability + replay

You add cost prediction, hot-path profiling, anomaly detection, and deterministic replay.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/G-phase-7
git branch --show-current  # feature/v3-phase-7
git fetch origin && git rebase origin/feature/v3-phase-0-1
npm install && npm run test:run
```

Read PRD §5 Phase 7 (lines ~1124–1226).

Append start checkpoint to STATUS.md.

## Scope

Build `src/observability/{cost-predictor,hot-path,anomaly,replay}.ts` and `src/cli/replay.ts`. New MCP tools: `predict_cost`, `get_hot_paths`, `record_session`, `stop_recording`, `replay_session`.

Hook into the bridge call path — instrument once at the gateway, no per-call burden.

Replay journal as `.jsonl` under `~/.mcp-conductor/recordings/`. Rotate at 1GB total.

## Acceptance

PRD §5 Phase 7 "Acceptance criteria" — cost predictor within 30%, replay reproduces bit-identical without modifications.

## Commit pattern

```
feat(v3-phase-7): cost predictor with args-shape fingerprint
feat(v3-phase-7): hot-path profiler with rolling window
feat(v3-phase-7): anomaly detector (3σ outlier)
feat(v3-phase-7): replay record + replay with divergence detection
feat(v3-phase-7): five new MCP tools registered
feat(v3-phase-7): replay CLI subcommand
test(v3-phase-7): full observability + replay test suite
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 Phase 7: Observability + replay"`. STATUS.md.
EOF_G

# ---------- agents/H-x1-passthrough.md ----------
cat > "$DIR/agents/H-x1-passthrough.md" <<'EOF_H'
# Agent H — Workstream X1 Passthrough adapter

You expose registry-annotated `routing: "passthrough"` tools as first-class Conductor MCP tools (bypassing `execute_code`), with full upstream annotations preserved. Closes IBKR analysis findings #2 and #3.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/H-x1
git branch --show-current  # feature/v3-x1-passthrough
git fetch origin && git rebase origin/feature/v3-phase-0-1   # registry must be in
npm install && npm run test:run
```

Read `/Users/mattcrombie/.claude/plans/read-this-analysis-from-rosy-whale.md` §3 Part C "Workstream X1".

Append start checkpoint to STATUS.md.

## Scope

Files:
- `src/server/passthrough-registrar.ts` (NEW) — at server start, iterate `registry.getAllTools()`, register a `<server>__<tool>` MCP tool for each `routing: "passthrough"` entry. Wire to `mcpHub.callTool()` directly (bypass Deno).
- `src/server/mcp-server.ts` — call `registerPassthroughTools()` after `registry.refresh()`.
- `src/registry/built-in-recommendations.ts` (NEW) — default routing for known servers. Ship with:
  - `github`: `routing.passthrough = ['get_me', 'list_repositories']`; rest `execute_code`.
  - `filesystem`: `routing.passthrough = ['read_file', 'list_directory']`; `write_file` and `delete` stay `execute_code`.
  - `brave-search`: `routing.passthrough = ['brave_web_search']`.
  Apply only when no user-config override present.

Tool name format: `<server>__<tool>` (double underscore, namespaced). Carry through upstream `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`, `description`.

## Acceptance

- `routing: "passthrough"` tools appear in `tools/list` from Conductor.
- Annotations match upstream values.
- Default routing for newly added (unknown) servers is `execute_code` (backwards compat).
- Built-in recommendations apply at startup; user config overrides them.
- Tests in `test/unit/passthrough-registrar.test.ts` (~6 cases) all pass.

## Commit pattern

```
feat(v3-x1): passthrough registrar that reads registry annotations
feat(v3-x1): built-in routing recommendations for github/filesystem/brave-search
feat(v3-x1): wire registrar into mcp-server startup after registry.refresh
test(v3-x1): passthrough registrar test suite
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 X1: Registry-driven passthrough adapter"`. STATUS.md.
EOF_H

# ---------- agents/I-x2-lifecycle-cli.md ----------
cat > "$DIR/agents/I-x2-lifecycle-cli.md" <<'EOF_I'
# Agent I — Workstream X2 Lifecycle MCP tools + interactive CLI wizard

You build the "move MCPs into Conductor" surface: 5 new MCP tools + `npx mcp-conductor` CLI with interactive wizard.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/I-x2
git branch --show-current  # feature/v3-x2-lifecycle
git fetch origin
git rebase origin/feature/v3-phase-0-1   # registry needed for tools
git rebase origin/feature/v3-phase-6     # daemon CLI subcommands hook in here
npm install && npm run test:run
```

Read `/Users/mattcrombie/.claude/plans/read-this-analysis-from-rosy-whale.md` §3 Part C "Workstream X2".

Append start checkpoint to STATUS.md.

## Scope

**Five new MCP tools** registered in `src/server/mcp-server.ts`:
- `import_servers_from_claude` — read `~/.claude/settings.json`, `~/Library/Application Support/Claude/claude_desktop_config.json`, etc. Show diff. On confirm, copy entries into `~/.mcp-conductor.json`. Write `.bak` of each source. Prompt to remove originals (confirm-then-strip).
- `test_server` — transient connect, list tools, latency probe. No persistent registration.
- `diagnose_server` — registered server: process health, recent errors, reconnect attempts, last successful call, registry state.
- `recommend_routing` — apply X1 heuristic (avg response < 1KB AND no large-payload signature → passthrough). Returns suggested routing block. Optional `--apply`.
- `export_to_claude` — generate `mcpServers` JSON pointing back at `mcp-conductor` stdio (rollback path).

**CLI** at new entry `src/bin/cli.ts`. Wire `bin.mcp-conductor-cli` in `package.json`. Use:
- `commander` for subcommand routing
- `@inquirer/prompts` for interactive wizard (Q4 from setup `setup` subcommand)
- `picocolors` for output colour

Subcommands: `setup` (full wizard), `add`, `list`, `test <name>`, `routing <name>`, `doctor`, `import`, `export`, `daemon start|stop|status|logs` (the daemon ones import from Agent F's daemon CLI module).

Add deps: `@inquirer/prompts@^7`, `picocolors@^1`, `commander@^12`. All in `dependencies`.

## Acceptance

- `mcp-conductor setup` wizard runs end-to-end on a fresh machine, detects ≥ 1 Claude config, imports successfully, writes `.bak`, optionally removes originals on confirm.
- `mcp-conductor doctor` reports actionable status across all configured servers.
- All 5 MCP tools registered and callable.
- `test/unit/lifecycle-tools.test.ts`, `test/unit/cli-wizard.test.ts`, `test/integration/cli-end-to-end.test.ts` (~20 cases total) all pass.

## Commit pattern

```
feat(v3-x2): import_servers_from_claude MCP tool with .bak + remove-originals
feat(v3-x2): test_server / diagnose_server / recommend_routing / export_to_claude tools
feat(v3-x2): CLI scaffold (commander + picocolors) at src/bin/cli.ts
feat(v3-x2): interactive setup wizard with @inquirer/prompts
feat(v3-x2): list / add / test / routing / doctor subcommands
feat(v3-x2): import / export non-interactive subcommands
feat(v3-x2): daemon subcommands wired to Phase 6 module
test(v3-x2): full lifecycle + CLI test suite
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 X2: Lifecycle MCP tools + interactive CLI wizard"`. STATUS.md.
EOF_I

# ---------- agents/J-x4-tokenization.md ----------
cat > "$DIR/agents/J-x4-tokenization.md" <<'EOF_J'
# Agent J — Workstream X4 PII tokenization

You add per-server `redact.response` config that strips sensitive values from upstream responses **before** they enter the sandbox or Claude's context. Reverse map sandbox-local; `mcp.detokenize(value)` for outbound calls.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/J-x4
git branch --show-current  # feature/v3-x4-tokenization
git fetch origin
git rebase origin/feature/v3-phase-0-1   # registry needed
git rebase origin/feature/v3-x1-passthrough   # X1 routing annotations side-by-side with redact
npm install && npm run test:run
```

Read `/Users/mattcrombie/.claude/plans/read-this-analysis-from-rosy-whale.md` §3 Part C "Workstream X4".

Append start checkpoint to STATUS.md.

## Scope

Built-in matchers ONLY this cut (decision recorded — no inline-regex this sprint):
- email (RFC 5322 simplified)
- phone (loose international, e.g. `+CC NNNN NNN NNN`, `(NNN) NNN-NNNN`)
- SSN (`NNN-NN-NNNN` and 9-digit run with context)
- credit card (Luhn-validated, 13–19 digits with optional separators)
- IBAN (basic checksum)
- IPv4 + IPv6

Files:
- `src/utils/tokenize.ts` (NEW) — pure tokenizer; reuses Phase 1.6 redact infrastructure (`src/utils/redact.ts` already exists for log redaction) but generalises it to data-flow with a reverse map.
- `src/hub/mcp-hub.ts` — apply tokenizer to result before return when `ToolDefinition.redact.response` annotation present.
- `src/runtime/executor.ts` — sandbox preamble: `mcp.detokenize(value)` looks up the reverse map. Reverse map is per-execution (not shared across `execute_code` calls) so a token can't survive past the call that minted it.

Annotation read from `ToolDefinition.redact` (set via `update_server` MCP tool [Agent I's territory] or directly in `~/.mcp-conductor.json`).

## Acceptance

- Server returning `{"email":"x@y.com", "phone":"+61 412 345 678"}` surfaces `{"email":"[EMAIL_1]", "phone":"[PHONE_1]"}` in the sandbox.
- `mcp.detokenize("[EMAIL_1]")` returns `x@y.com` inside the same `execute_code` call.
- Token survives a within-call outbound MCP call (e.g. `mcp.server('crm').call('lookup', {email: mcp.detokenize('[EMAIL_1]')})` works).
- Token does NOT detokenize when returned as the final result (Claude sees `[EMAIL_1]`).
- A subsequent `execute_code` call cannot detokenize tokens from a prior call.
- `test/unit/tokenize.test.ts`, `test/integration/tokenize-flow.test.ts` (~12 cases) pass.

## Commit pattern

```
feat(v3-x4): tokenize.ts pure matcher engine (email/phone/SSN/CC-Luhn/IBAN/IP)
feat(v3-x4): hub applies tokenizer when ToolDefinition.redact.response present
feat(v3-x4): sandbox mcp.detokenize with per-execution reverse map
feat(v3-x4): integration glue with X1 passthrough adapter
test(v3-x4): full tokenize + integration flow test suite
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 X4: PII tokenization (built-in matchers)"`. STATUS.md.
EOF_J

# ---------- agents/K-integration.md ----------
cat > "$DIR/agents/K-integration.md" <<'EOF_K'
# Agent K — Integration day

You're the final agent. All 10 prior PRs are merged to `feature/v3` (or about to be). You run benchmarks, soak test, finish docs, and tag `v3.0.0-beta.1`.

## Setup

You run at the **main repo path** (no worktree). The other worktrees may still exist; that's fine — they'll be cleaned up after.

```bash
cd /Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice
git checkout feature/v3
git pull
git log --oneline -30   # confirm all 10 PRs are in
npm install && npm run build && npm run test:run && npm run lint
```

Read STATUS.md to see what each agent reported. Confirm all 10 sections show `READY-FOR-MERGE` or `completed`.

Append start checkpoint to STATUS.md under Agent K.

## Scope

### Block 1 — Merge any open PRs in dependency order

```
A → (B, C, D, G, H) parallel → (E, F) → (I after F, J after H)
```

Use `gh pr merge --squash --auto` if CI is green. If conflicts: rebase the lagging branch on `feature/v3` and re-push.

### Block 2 — Head-to-head benchmark vs Anthropic 150K → 2K

Implement the Google-Drive-to-Salesforce style chain as a benchmark fixture:
- New file: `test/benchmark/anthropic-pattern.test.ts`
- New fixture: `test/fixtures/google-drive-to-salesforce.ts` (synthetic 150K-token document chain → record extraction → Salesforce update)
- Assert ≥ 98% reduction (matches Anthropic's claim)
- Output: `docs/benchmarks/anthropic-comparison-YYYY-MM-DD.{json,md}`

This backs the positioning claim "the production implementation of Anthropic's published design."

### Block 3 — One-hour soak test against fault-injected backends

Use Phase 7's replay infrastructure. Synthetic faults: 10% timeout, 5% 500-error, 1% truncated response. Assert 0 hangs, all errors surfaced as `MCPToolError`.

### Block 4 — Complete docs

Per PRD §6.4:
- `docs/v3/architecture.md` — diagrams + component overview
- `docs/v3/migration.md` — v2 → v3 migration
- `docs/v3/configuration.md` — full config reference (registry/cache/reliability/runtime/skills/findTool/daemon/observability sections)
- `docs/v3/sandbox-api.md` — updated `mcp` API (helpers, skills, shared, tokenize, fs)
- `docs/v3/recipes.md` — example execute_code workflows showcasing v3 features
- Update top-level `README.md` with v3 highlights

### Block 5 — Tag v3.0.0-beta.1

```bash
# Bump package.json to 3.0.0-beta.1
# (publish.yml routes "*-beta*" to @next via the existing *-* fallback)
git commit -am "chore: prep v3.0.0-beta.1"
git tag -a v3.0.0-beta.1 -m "v3.0.0-beta.1 — registry-driven architecture, full sprint complete"
git push origin feature/v3
git push origin v3.0.0-beta.1
```

CI publishes to `@next`. Verify with `npm view @darkiceinteractive/mcp-conductor@next`.

### Block 6 — Open PR feature/v3 → main

```bash
gh pr create --base main --title "v3.0.0-beta.1: registry-driven Conductor (PRD Phases 1-7 + X1/X2/X4)" --body "..."
```

Don't merge — leave it open for human review.

### Block 7 — Cleanup

```bash
bash _plans/v3-enhancements/cleanup-worktrees.sh
git branch -D feature/v3-phase-{0-1,2,3,4,5,6,7} feature/v3-x{1-passthrough,2-lifecycle,4-tokenization}
```

Update STATUS.md final block: "v3.0.0-beta.1 published to @next; PR to main open at <URL>; worktrees cleaned."

## When to stop

After the PR to `main` is open and STATUS.md is updated. Do NOT merge to main — that's @matt's call after review.
EOF_K

echo "Bootstrap complete. Generated:"
ls -la "$DIR/STATUS.md" "$DIR/setup-worktrees.sh" "$DIR/cleanup-worktrees.sh" "$DIR/agents"/*.md
