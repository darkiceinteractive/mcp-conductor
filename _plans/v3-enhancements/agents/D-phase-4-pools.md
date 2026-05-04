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
