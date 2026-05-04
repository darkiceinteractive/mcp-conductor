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
