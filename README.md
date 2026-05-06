# MCP Conductor

**The canonical MCP hub for any agent platform. 99.7% fewer tokens. One `npx` command.**

[![npm version](https://img.shields.io/npm/v/@darkiceinteractive/mcp-conductor.svg?style=flat)](https://www.npmjs.com/package/@darkiceinteractive/mcp-conductor)
[![npm downloads](https://img.shields.io/npm/dm/@darkiceinteractive/mcp-conductor.svg?style=flat)](https://www.npmjs.com/package/@darkiceinteractive/mcp-conductor)
[![CI](https://github.com/darkiceinteractive/mcp-conductor/actions/workflows/ci.yml/badge.svg)](https://github.com/darkiceinteractive/mcp-conductor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Deno](https://img.shields.io/badge/runtime-Deno%202.x-black?logo=deno)](https://deno.land)

MCP Conductor is a single MCP server that orchestrates all your other MCP servers through a sandboxed Deno runtime. Works with Claude Code, Claude Desktop, Cursor, Gemini CLI, Codex CLI, Cline, Zed, Continue.dev, OpenCode, and Kimi Code. Instead of your AI client making direct tool calls (and dumping every intermediate result into your context window), it writes TypeScript code that runs in an isolated sandbox. Only the final result comes back.

```
Before: 153,900 tokens → AI client context window → 153,900 tokens billed
After:  153,900 tokens → Deno sandbox → 435 tokens → AI client context window
```

**Average measured reduction: 99.7%. Verified against Anthropic's published benchmarks.**

---

## Quick Install

### v3.1.1 — Supported Clients

| Client | Config path (macOS) | Config path (Linux) | Config path (Windows) |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | `~/.claude/settings.json` | `%APPDATA%\Claude Code\claude_code_config.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `~/.config/claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/mcp.json` | `~/.cursor/mcp.json` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/settings.json` | `~/.gemini/settings.json` |
| Codex CLI | `~/.codex/config.toml` | `~/.codex/config.toml` | `~/.codex/config.toml` |
| Cline | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |
| Zed | `~/Library/Application Support/Zed/settings.json` | `~/.config/zed/settings.json` | `%LOCALAPPDATA%\Zed\settings.json` |
| Continue.dev | `~/.continue/config.yaml` | `~/.continue/config.yaml` | `~/.continue/config.yaml` |
| OpenCode | `~/.config/opencode/opencode.json` | `~/.config/opencode/opencode.json` | `%APPDATA%\opencode\opencode.json` |
| Kimi Code | `~/Library/Application Support/Kimi Code/mcp_settings.json` | `~/.config/kimi-code/mcp_settings.json` | `%APPDATA%\Kimi Code\mcp_settings.json` |

### Guided Setup (recommended)

The setup wizard auto-detects every supported client on your machine and offers per-client consolidation:

```bash
npx -y @darkiceinteractive/mcp-conductor-cli@next setup
```

See [What the wizard does](#what-the-wizard-does) below.

### Manual Config Snippets

Paste the appropriate block into your client's config file. The wizard does this automatically.

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"]
    }
  }
}
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"]
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"]
    }
  }
}
```

For Codex CLI (TOML), Continue.dev (YAML), and other formats, use `mcp-conductor-cli export --client <id>` — see [Multi-client export](#multi-client-export).

Restart your AI tool after editing the config. That's it.

---

## What the Wizard Does

Running `npx -y @darkiceinteractive/mcp-conductor-cli@next setup` steps through the following for each detected client:

1. **Scan** — discovers all 10 client config locations on your machine (global and project-local).
2. **Diff** — for each existing config, parses the current server list and shows what will move.
3. **Confirm per-client** — prompts once per client; you can skip any client individually.
4. **Write conductor config** — merges your existing servers into `~/.mcp-conductor.json` and installs the conductor entry back into the client config.
5. **Backup originals** — creates a timestamped `.bak.YYYYMMDDHHMMSS` copy of every config file before modifying it.

In non-interactive environments (CI, piped stdin) the wizard proceeds automatically with safe defaults.

---

## Verifying Setup

```bash
mcp-conductor-cli doctor
```

The `doctor` command runs a health check across all configured servers and prints an **MCP CLIENT COVERAGE** section showing every detected client config with an `[OK]` or `[MISSING]` status for the conductor entry.

```
MCP CLIENT COVERAGE
  [OK]      Claude Code        ~/.claude/settings.json
  [OK]      Claude Desktop     ~/Library/Application Support/Claude/claude_desktop_config.json
  [OK]      Cursor             ~/.cursor/mcp.json
  [MISSING] Zed                ~/Library/Application Support/Zed/settings.json
```

Run `npx -y @darkiceinteractive/mcp-conductor-cli@next setup` to install the conductor entry in any `[MISSING]` client.

---

## Multi-client Export

Generate a ready-to-paste config snippet for any supported client:

```bash
# Codex CLI — writes TOML
mcp-conductor-cli export --client codex

# Continue.dev — writes YAML
mcp-conductor-cli export --client continue

# Claude Desktop — writes JSON (default)
mcp-conductor-cli export --client claude-desktop
```

The exported file is written to the current directory as `<client>-config.<ext>`. Pass `--output <path>` to override.

Full client setup documentation is at **[docs.darkice.co/setup/clients](https://docs.darkice.co/setup/clients)**.

---

## 30-Second Example

```typescript
// Your AI client writes this code, which runs inside the Deno sandbox
const [issues, files] = await mcp.batch([
  () => mcp.server('github').call('list_issues', { owner: 'myorg', repo: 'myrepo', state: 'open' }),
  () => mcp.server('filesystem').call('list_directory', { path: '/src' })
]);

return {
  openBugs: issues.filter(i => i.labels.some(l => l.name === 'bug')).length,
  tsFiles: files.filter(f => f.name.endsWith('.ts')).length
};
// Returns: {"openBugs": 12, "tsFiles": 47}  ←  under 100 tokens
```

---

## Why It Matters

When an AI client calls MCP tools directly, every response lands in the context window — raw JSON, file metadata, pagination objects, fields you never asked for. A single GitHub `list_issues` call can return 40,000+ tokens. If you're making 10 calls per task, that's 400,000 tokens before the model has written a single line of code.

MCP Conductor flips the model: the client writes TypeScript code that *processes* the tool responses inside a Deno sandbox. The sandbox can call any connected MCP server, filter and aggregate the results, and return only the compact summary. Your context window stays small. Your costs stay low.

| Scenario | Without Conductor | With Conductor | Reduction |
|---|---|---|---|
| 300-document Drive pipeline | 153,900 tokens | 435 tokens | **99.72%** |
| GitHub issues triage (10 repos) | ~400,000 tokens | ~2,000 tokens | **99.5%** |
| Web research (5 searches) | ~50,000 tokens | ~800 tokens | **98.4%** |

---

## v3 Highlights

| Feature | What it does | Docs |
|---|---|---|
| Tool Registry | Schema validation, hot-reload, type generation | [Architecture](https://docs.darkice.co/docs/v3/architecture) |
| Response Cache | LRU + CBOR serialisation, TTL per tool | [Configuration](https://docs.darkice.co/docs/v3/configuration) |
| Reliability Gateway | Timeout, retry, circuit breaker | [Architecture](https://docs.darkice.co/docs/v3/architecture) |
| Connection Pool | Warm sandbox pool, persistent server connections | [Configuration](https://docs.darkice.co/docs/v3/configuration) |
| Sandbox API | `compact`, `summarize`, `findTool`, `budget` | [Sandbox API](https://docs.darkice.co/docs/v3/sandbox-api) |
| Daemon Mode | Shared KV store, distributed lock | [Configuration](https://docs.darkice.co/docs/v3/configuration) |
| Observability | Cost predictor, hot-path profiler, session replay | [Architecture](https://docs.darkice.co/docs/v3/architecture) |
| Passthrough Adapter | Expose backend tools directly (X1) | [Recipes](https://docs.darkice.co/docs/v3/recipes) |
| Lifecycle Tools + CLI | `import_servers_from_claude`, setup wizard (X2) | [Sandbox API](https://docs.darkice.co/docs/v3/sandbox-api) |
| PII Tokenisation | Built-in redaction matchers (X4) | [Configuration](https://docs.darkice.co/docs/v3/configuration) |

## v3.1.1 Additions

| Feature | What it does |
|---|---|
| Multi-client adapters | Read and write configs for all 10 supported clients |
| Setup wizard (MC3) | Interactive per-client consolidation with backups |
| Per-client export (MC4) | `export --client <id>` writes the correct format (JSON / TOML / YAML) |
| Doctor client coverage (MC5) | `doctor` reports `[OK]` / `[MISSING]` per detected client config |

Migrating from v2? See the [migration guide](https://docs.darkice.co/docs/v3/migration).

---

## Token-Savings Reporter

Pass `show_token_savings: true` on any `execute_code` call to see a breakdown:

```json
{
  "result": { "processed": 300, "with_dates": 287 },
  "tokenSavings": {
    "estimatedPassthroughTokens": 153900,
    "actualExecutionTokens": 435,
    "tokensSaved": 153465,
    "savingsPercent": 99.72
  }
}
```

Or enable it globally in `~/.mcp-conductor.json`:

```json
{
  "metrics": {
    "alwaysShowTokenSavings": true
  }
}
```

Session totals are always available via `get_metrics`.

---

## Docs

Full documentation at **https://docs.darkice.co** — deploys at D4. In the meantime, all reference material is in [`docs/v3/`](./docs/v3/).

| Guide | Description |
|-------|-------------|
| [Architecture](./docs/v3/architecture.md) | System design and data flow |
| [Configuration](./docs/v3/configuration.md) | All config options |
| [Sandbox API](./docs/v3/sandbox-api.md) | The `mcp` object inside `execute_code` |
| [Recipes](./docs/v3/recipes.md) | Practical patterns and examples |
| [Migration (v2 → v3)](./docs/v3/migration.md) | Breaking changes and migration steps |
| [Client Setup](https://docs.darkice.co/setup/clients) | Per-client config reference for all 10 supported clients |

---

## CLI Quick-Start

```bash
# Guided multi-client setup — detects all supported client configs automatically
npx -y @darkiceinteractive/mcp-conductor-cli@next setup

# Health check with client coverage report
mcp-conductor-cli doctor

# Export config for a specific client (TOML for Codex, YAML for Continue, etc.)
mcp-conductor-cli export --client <client-id>

# Check system requirements (Node, Deno, conductor config)
mcp-conductor-cli check

# Show current configuration status
mcp-conductor-cli status

# Enable exclusive mode (routes all MCP calls through the sandbox)
mcp-conductor-cli enable-exclusive [--dry-run]

# Add a backend server
mcp-conductor-cli config add github npx -- -y @modelcontextprotocol/server-github
```

---

## Contributing

Contributions welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

- **Bug reports:** [GitHub Issues](https://github.com/darkiceinteractive/mcp-conductor/issues)
- **Discussions:** [GitHub Discussions](https://github.com/darkiceinteractive/mcp-conductor/discussions)
- **Security:** See [SECURITY.md](./SECURITY.md)

---

## Licence

MIT — see [LICENSE](./LICENSE)

---

*Built by [DarkIce Interactive](https://darkiceinteractive.com) · [@darkiceinteractive/mcp-conductor on npm](https://www.npmjs.com/package/@darkiceinteractive/mcp-conductor)*
