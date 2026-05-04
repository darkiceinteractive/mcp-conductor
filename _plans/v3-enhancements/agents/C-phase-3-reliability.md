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
