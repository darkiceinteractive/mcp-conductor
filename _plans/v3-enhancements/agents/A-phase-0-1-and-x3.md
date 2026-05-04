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
