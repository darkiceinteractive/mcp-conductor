# MCP Conductor

**99.7% fewer tokens. Parallel execution. One `npx` command.**

[![npm version](https://img.shields.io/npm/v/@darkiceinteractive/mcp-conductor.svg?style=flat)](https://www.npmjs.com/package/@darkiceinteractive/mcp-conductor)
[![npm downloads](https://img.shields.io/npm/dm/@darkiceinteractive/mcp-conductor.svg?style=flat)](https://www.npmjs.com/package/@darkiceinteractive/mcp-conductor)
[![CI](https://github.com/darkiceinteractive/mcp-conductor/actions/workflows/ci.yml/badge.svg)](https://github.com/darkiceinteractive/mcp-conductor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Deno](https://img.shields.io/badge/runtime-Deno%202.x-black?logo=deno)](https://deno.land)

MCP Conductor is a single MCP server that orchestrates all your other MCP servers through a sandboxed Deno runtime. Instead of Claude making direct tool calls (and dumping every intermediate result into your context window), Claude writes TypeScript code that runs in an isolated sandbox. Only the final result comes back.

```
Before: 153,900 tokens → Claude context window → 153,900 tokens billed
After:  153,900 tokens → Deno sandbox → 435 tokens → Claude context window
```

**Average measured reduction: 99.7%. Verified against Anthropic's published benchmarks.**

---

## Quick Install

**Claude Code** (`~/.claude/settings.json`), **Claude Desktop**, **Gemini CLI**, **Cursor**, **Windsurf**, **Cline**, or **VS Code**:

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

Restart your AI tool. That's it.

---

## 30-Second Example

```typescript
// Claude writes this code, which runs inside the Deno sandbox
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

When Claude calls MCP tools directly, every response lands in the context window — raw JSON, file metadata, pagination objects, fields you never asked for. A single GitHub `list_issues` call can return 40,000+ tokens. If you're making 10 calls per task, that's 400,000 tokens before Claude has written a single line of code.

MCP Conductor flips the model: Claude writes TypeScript code that *processes* the tool responses inside a Deno sandbox. The sandbox can call any connected MCP server, filter and aggregate the results, and return only the compact summary. Your context window stays small. Your costs stay low.

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

---

## CLI Quick-Start

```bash
# Guided setup — detects Claude Code / Desktop configs automatically
npx @darkiceinteractive/mcp-conductor setup

# Check system requirements (Node, Deno, Claude config)
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
