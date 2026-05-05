# v3.1.1 Patch — Multi-Client Setup Wizard

**Status**: planned 2026-05-06; awaiting research-agent verification of client config paths
**Branch**: `release/v3.1.1` (off `main` after rc.2 promotes to `@latest` OR off `main` directly if shipped during soak)
**Target tag**: `v3.1.1` → `@next` → 3-day soak → `@latest`
**Scope size**: ~1-2 days work
**Backwards compat**: pure additive — Claude-only behaviour unchanged

## Why 3.1.1 not v3.2

The setup wizard currently scans Claude Code + Claude Desktop only. MCP is now a multi-client ecosystem (Codex, Gemini CLI, Cursor, Cline, Continue, Zed, OpenCode, Kimi, Grok, etc.). For the product to be the canonical "single MCP hub" it claims to be, the wizard must speak every client's config dialect.

This is purely additive surface — no behavioural changes to existing Claude paths — so it fits the `3.1.x` patch contract under semver. Strict v3.2 stays focused on capability completion (C1-C5).

## Block ledger

| ID | Title | Effort |
|---|---|---|
| MC1 | Generalise `getClaudeConfigPaths()` → `getMCPClientConfigPaths()` returning typed `{client, path, format, mcpKey, schemaShape}[]` | 2h |
| MC2 | Per-client adapter modules in `src/cli/clients/*.ts` — one per client. Each exports `discover()`, `parse(file)`, `serialize(config)`. Common interface `MCPClientAdapter`. | 4h |
| MC3 | Wizard refactor — scan all known clients, group diff per-client, optional bulk strip per-client (with confirm), install conductor entry in each | 3h |
| MC4 | `mcp-conductor-cli export --client <name>` writes the right format for that target client | 2h |
| MC5 | `mcp-conductor-cli doctor` extends to detect conductor entry in all known clients (warn if missing in any) | 1h |
| MC6 | Brand surface scrub — replace "Claude" with "MCP client" universally in CLI/help text where multi-client behaviour applies | 1h |
| MC7 | Tests: per-client fixtures in `test/fixtures/clients/` + adapter unit tests + wizard end-to-end with multi-client mock filesystem | 4h |
| MC8 | Docs site: new page `docs.darkice.co/setup/clients` listing supported clients, restart procedures per-client | 1h |
| MC9 | README v3.1.1 refresh — multi-client install instructions, supported-client table | 30m |

## Adapter target list (verified 2026-05-06)

| Client | macOS path | Format | MCP key | Per-server shape | Adapter complexity |
|---|---|---|---|---|---|
| **Claude Code** | `~/.claude.json`, `~/.claude/settings.json`, project `.mcp.json` | JSON | `mcpServers` | `{command, args, env}` — Anthropic canonical | low (refactor existing) |
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` | JSON | `mcpServers` | `{command, args, env}` — Anthropic canonical | low (refactor existing) |
| **Codex CLI** | `~/.codex/config.toml` (global); `.codex/config.toml` (project) | **TOML** | `[mcp_servers.<name>]` table | `command`, `args`, **`env_vars`** (not `env`) | medium — TOML parser + key translation |
| **Gemini CLI** | `~/.gemini/settings.json` (global); `.gemini/settings.json` (project) | JSON | `mcpServers` | `{command, args, env}` + extra `timeout`, tool filters | low |
| **Cursor** | `~/.cursor/mcp.json` (global); project `.cursor/mcp.json` | JSON | `mcpServers` | `{command, args, env}` — Anthropic canonical | low |
| **Cline (VS Code)** | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | JSON | `mcpServers` | `{command, args, env}` — Anthropic canonical | low |
| **Zed** | `~/.config/zed/settings.json` | JSON | **`context_servers`** | `{source: "custom", command, args, env}` — schema translation | medium |
| **Continue.dev** | `~/.continue/config.yaml` (global); `.continue/mcpServers/*.yaml` drop-ins | **YAML** | `mcpServers` | `{command, args, env}` | low — YAML parser only |
| **OpenCode** | `~/.config/opencode/opencode.json` (global); `./opencode.json` (project) | JSON | **`mcp`** (not `mcpServers`) | `{type, command, args, env, enabled}` — `type` required | low — key + type-field translation |
| **Kimi Code** | `~/.kimi/` (uses `--mcp-config-file` flag — accepts existing Anthropic configs) | JSON | `mcpServers` | `{command, args}` or `{url, headers}` — fully Anthropic-compatible | low |

**EXCLUDED — no local agent / no MCP**:

| Client | Reason |
|---|---|
| **Grok / xAI** | No local CLI agent. MCP is API-level server-side remote tool feature only — no local config to consolidate. Document in adapter README. |

**Total adapters to ship**: 10. Of those, 2 already exist (refactored), 8 new — 5 trivial (JSON `mcpServers` Anthropic-shape), 3 with translation (Codex `env_vars`/TOML, Zed `context_servers`/source-field, OpenCode `mcp`/`type`-field).

**Deps to add**:
- `yaml` (~30KB) for Continue + Zed YAML alternates
- `@iarna/toml` (~50KB) for Codex
- ~80KB total — acceptable for a CLI binary

## Wave plan

- **Wave 1** (sequential — foundation): MC1 + MC2 (adapter scaffold) — 1 dev day
- **Wave 2** (parallel — adapters): one agent per client adapter (~30min each, 8-10 in parallel) — 2h calendar
- **Wave 3**: MC3 (wizard refactor) + MC4 (export per-client) + MC5 (doctor extend) — sequential, 1 dev day
- **Wave 4**: MC6 (brand) + MC7 (tests) + MC8 (docs) + MC9 (readme) — parallel, half day
- **Release**: tag `v3.1.1` → `@next` → 3-day soak → `@latest`

## Acceptance

- [ ] `mcp-conductor-cli setup` discovers all 8+ clients on a machine that has them
- [ ] Per-client diff displayed with explicit consent before any write
- [ ] `.bak.YYYYMMDDHHMMSS` written for every modified file
- [ ] `mcp-conductor-cli doctor` reports "conductor missing" for any client where it's absent
- [ ] Tests cover all adapters with fixture files matching real-world configs
- [ ] No regression on Claude-only setups (existing test suite green)
- [ ] Docs page lists every supported client with restart procedure

## Risks

- **Client config schemas drift fast** — pin to "as of YYYY-MM-DD" in adapter docstring; bake schema validation at parse time so silent format changes fail loud.
- **YAML/TOML parsers add deps** — Zed/Continue need YAML, Codex needs TOML. Use `yaml` + `@iarna/toml` (both small, MIT). Total bundle add: ~50KB.
- **Some clients don't expose stable config paths** — VS Code extensions store in `globalStorage/<extension-id>/`, extension IDs change. Document the resolution logic clearly in adapter.
- **User confusion if a client is auto-detected but they don't use it** — wizard must show "skip" per-client, never assume installation = use.

## Out of scope (defer to v3.2 or later)

- Auto-restarting clients post-config-write (each has different IPC; risky to automate)
- Detecting whether the user's chosen LLM in each client actually supports MCP (e.g. Cline + a non-tool-use model)
- Cross-client server-name conflict resolution (if Cursor calls it `gh` and Claude calls it `github` for the same server)
- Live config sync (watching changes in one client and propagating to conductor)
