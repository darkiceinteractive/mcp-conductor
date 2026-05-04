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
