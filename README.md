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

## What's New in v3 (beta)

v3 is a ground-up registry-driven architecture. Every backend tool is described, validated, and type-generated at startup. New workstreams add production-grade reliability, caching, observability, and multi-agent coordination.

| Workstream | Feature | Docs |
|---|---|---|
| Phase 1 | Tool Registry — schema validation, hot-reload, type generation | [architecture](./docs/v3/architecture.md) |
| Phase 2 | Response cache — LRU + CBOR serialisation, TTL per tool | [configuration](./docs/v3/configuration.md) |
| Phase 3 | Reliability gateway — timeout, retry, circuit breaker | [architecture](./docs/v3/architecture.md) |
| Phase 4 | Connection pool + warm sandbox pool | [configuration](./docs/v3/configuration.md) |
| Phase 5 | Sandbox API — `compact`, `summarize`, `findTool`, `budget` | [sandbox-api](./docs/v3/sandbox-api.md) |
| Phase 6 | Daemon mode, shared KV store, distributed lock | [configuration](./docs/v3/configuration.md) |
| Phase 7 | Structured observability, session replay | [architecture](./docs/v3/architecture.md) |
| X1 | Passthrough adapter — expose backend tools directly | [recipes](./docs/v3/recipes.md) |
| X2 | Lifecycle tools, CLI wizard | [sandbox-api](./docs/v3/sandbox-api.md) |
| X4 | PII tokenisation, response redaction | [configuration](./docs/v3/configuration.md) |

Migrating from v2? See the [migration guide](./docs/v3/migration.md).

---

## Quick Start

### 1. Install Deno

```bash
# macOS
brew install deno

# Linux
curl -fsSL https://deno.land/install.sh | sh

# Windows
winget install DenoLand.Deno
```

### 2. Add to Your AI Tool

**Claude Code** (`~/.claude/settings.json`), **Claude Desktop**, **Gemini CLI** (`~/.gemini/settings.json`), **Kimi CLI** (`~/.kimi/mcp.json`), **Cursor** (`.cursor/mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`), **Cline**, or **VS Code** (`.vscode/mcp.json`):

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

**OpenAI Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.mcp-conductor]
command = "npx"
args = ["-y", "@darkiceinteractive/mcp-conductor"]
```

> **Note:** VS Code uses `"servers"` instead of `"mcpServers"` and requires `"type": "stdio"`. See the [full multi-platform guide](./docs/guide/mcp-clients.md) for exact config per platform.

### 3. Restart Your AI Tool

That's it. Ask your AI to list MCP servers — you should see `mcp-conductor` with its tools.

---

## What This Solves

When Claude calls MCP tools directly, every response lands in the context window — raw JSON, file metadata, pagination objects, fields you never asked for. A single GitHub `list_issues` call can return 40,000+ tokens. If you're making 10 calls per task, that's 400,000 tokens before Claude has written a single line of code.

MCP Conductor flips the model: Claude writes TypeScript code that *processes* the tool responses inside a Deno sandbox. The sandbox can call any connected MCP server, filter and aggregate the results, and return only the compact summary. Your context window stays small. Your costs stay low.

```typescript
// This runs inside the Deno sandbox — not in Claude's context window
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

## How It Works

```
Claude
  └── execute_code (writes TypeScript)
        └── Deno Sandbox (50ms startup, <50MB RAM)
              ├── mcp.server('github').call(...)     ← your MCP servers
              ├── mcp.server('filesystem').call(...) ← hidden from Claude
              └── mcp.server('brave-search').call(...)
                    └── return { compact: "summary" } → back to Claude
```

The Deno sandbox runs with minimal permissions:
- Network: localhost bridge only
- No filesystem access (MCP handles that)
- No environment variable access
- No subprocess spawning

**Why Deno?** 50ms cold start vs 500ms–2s for Docker, under 50MB vs 200MB+ memory overhead, TypeScript natively, granular permission model.

---

## Adding Your Servers

Create `~/.mcp-conductor.json` to register backend servers:

```json
{
  "exclusive": true,
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/yourname"],
      "env": {}
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "your-token" }
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
      "env": { "BRAVE_API_KEY": "your-key" },
      "rateLimit": {
        "requestsPerSecond": 20,
        "burstSize": 20,
        "onLimitExceeded": "queue",
        "maxQueueTimeMs": 30000
      }
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {}
    }
  }
}
```

Set `"exclusive": true` to route *all* MCP calls through the sandbox. This is the recommended setting for maximum token savings — Claude cannot bypass the conductor.

**Hot reload:** Edit the file and save. Changes apply in ~500ms, no restart needed.

---

## The `mcp` API

Inside `execute_code`, you have access to the `mcp` object:

```typescript
// Call a server tool
const result = await mcp.server('github').call('list_issues', { owner: 'org', repo: 'repo' });

// Parallel execution — executes all calls simultaneously.
// Two call shapes are supported:
//
//   1. Callback form (composable, no rate-limit detection):
const [issues, files, searches] = await mcp.batch([
  () => mcp.server('github').call('list_issues', { owner: 'org', repo: 'repo' }),
  () => mcp.server('filesystem').call('list_directory', { path: '/src' }),
  () => mcp.server('brave-search').call('search', { q: 'topic', count: 5 })
]);

//   2. Descriptor form (rate-limit aware, retries on 429s):
const [a, b] = await mcp.batch([
  { server: 'github', tool: 'list_issues', params: { owner: 'org', repo: 'repo' } },
  { server: 'filesystem', tool: 'list_directory', params: { path: '/src' } },
]);

// Batch web searches (handles rate limits automatically)
const results = await mcp.batchSearch(['query 1', 'query 2', 'query 3'], { topN: 3 });

// Progress updates (visible in Claude)
mcp.progress('Processing 500 files...');

// Debug logging
console.log('issue count:', issues.length);
```

---

## Measuring Your Savings

After any workflow, ask Claude to call `get_metrics`:

```json
{
  "totalExecutions": 47,
  "averageCompressionRatio": 0.943,
  "totalTokensSaved": 1847230,
  "averageExecutionMs": 73,
  "lastExecution": {
    "compressionRatio": 0.978,
    "tokensSaved": 44200,
    "inputTokens": 45000,
    "outputTokens": 800
  }
}
```

`compressionRatio: 0.978` means 97.8% of tokens were processed inside the sandbox rather than billed to your context window. `totalTokensSaved: 1,847,230` is the cumulative count across all 47 executions.

---

## MCP Tools Available to Claude

| Tool | Description |
|------|-------------|
| `execute_code` | Run TypeScript in the Deno sandbox with MCP server access |
| `list_servers` | List all connected backend servers |
| `discover_tools` | Search for tools across all servers |
| `get_metrics` | Session statistics and compression ratios |
| `set_mode` | Switch between `execution`, `passthrough`, or `hybrid` mode |
| `compare_modes` | Compare how a task runs in each mode |
| `add_server` | Add a server to the conductor config at runtime |
| `remove_server` | Remove a server at runtime |
| `update_server` | Update a server's config (e.g. rotate an API key) without restart |
| `reload_servers` | Reload config after manual edits |
| `passthrough_call` | Make a direct tool call (high token cost — debug only) |

---

## CLI Reference

```bash
# Check system requirements (Node, Deno, Claude config)
mcp-conductor-cli check

# Show current configuration status
mcp-conductor-cli status

# Enable exclusive mode (migrates servers to ~/.mcp-conductor.json)
mcp-conductor-cli enable-exclusive [--dry-run]

# Disable exclusive mode (restores servers to Claude config)
mcp-conductor-cli disable-exclusive [--dry-run]

# Add/remove/list servers in conductor config
mcp-conductor-cli config add <name> <command> [args...]
mcp-conductor-cli config remove <name>
mcp-conductor-cli config servers

# Manage Claude Code permissions (auto-allow all MCP tools)
mcp-conductor-cli permissions discover --new-only
mcp-conductor-cli permissions add [--scope project]

# Install CLAUDE.md to teach Claude to use execute_code
mcp-conductor-cli install-instructions --dir /path/to/project
```

---

## Recipes

### Parallel GitHub + Filesystem analysis

```typescript
mcp.progress('Fetching issues and scanning codebase...');
const [issues, files] = await mcp.batch([
  () => mcp.server('github').call('list_issues', { owner: 'myorg', repo: 'myrepo', state: 'open', per_page: 100 }),
  () => mcp.server('filesystem').call('search_files', { path: '/src', pattern: '*.ts' })
]);
return {
  openBugs: issues.filter(i => i.labels.some(l => l.name === 'bug')).length,
  tsFileCount: files.length
};
```

### Parallel web research

```typescript
const topics = ['MCP protocol 2026', 'Deno performance benchmarks', 'token optimization AI'];
const results = await mcp.batch(
  topics.map(q => () => mcp.server('brave-search').call('search', { q, count: 5 }))
);
return results.map((r, i) => ({ topic: topics[i], topResult: r[0]?.title, url: r[0]?.url }));
```

### Cross-session memory persistence

```typescript
// Session 1: store results
const analysis = { /* ... your analysis ... */ };
await mcp.server('memory').call('store', { key: 'weekly-audit', value: analysis });
return analysis;

// Session 2: retrieve and compare
const previous = await mcp.server('memory').call('retrieve', { key: 'weekly-audit' });
// diff previous vs current...
```

---

## Troubleshooting

**"Deno not found"** — Install Deno, then `source ~/.zshrc` (or open a new terminal). Verify with `deno --version`.

**"Server not connecting"** — Validate your JSON: `cat ~/.mcp-conductor.json | python3 -m json.tool`. Check that env vars are set (not still saying `"your-token"`).

**"`exclusive` mode not working"** — `"exclusive": true` must be at the root level, not inside `"servers"`.

**"Rate limit errors from brave-search"** — Add a `rateLimit` block to the server config (see example above). Set `onLimitExceeded: "queue"` to buffer requests.

**"Config changes not applying"** — The file watcher requires valid JSON. If you saved a file with a syntax error, fix it and save again.

Full troubleshooting guide: [docs/troubleshooting.md](./docs/troubleshooting.md)

---

## Development

```bash
git clone https://github.com/darkiceinteractive/mcp-conductor.git
cd mcp-conductor
npm install
npm run build
npm run test:run           # 673 tests, 82% coverage
npm run test:coverage      # with coverage report
npm run dev                # watch mode
```

**Requirements:** Node.js 18+, Deno 2.x

---

## Architecture

Full architecture documentation: [docs/guide/](./docs/guide/)

```
Claude Code / Claude Desktop
    │
    └── MCP Protocol
            │
    ┌───────▼──────────────┐
    │    MCP Conductor      │
    │  (Node.js MCP server) │
    │                       │
    │  execute_code ──────► Deno Subprocess (50ms, <50MB)
    │  list_servers         │   TypeScript code runs here
    │  get_metrics          │   MCP calls via HTTP bridge
    │  add_server           │   Only result exits sandbox
    └───────────────────────┘
              │
    ┌─────────▼──────────────────────────────┐
    │         HTTP Bridge (localhost)         │
    └──┬──────────┬──────────┬───────────────┘
       │          │          │
   github     filesystem  brave-search  ... (any MCP server)
```

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](./docs/guide/getting-started.md) | First-time setup walkthrough |
| [MCP Clients](./docs/guide/mcp-clients.md) | Setup for Claude, Codex, Gemini, Kimi, VS Code, Cursor, Windsurf, Cline |
| [Configuration](./docs/configuration.md) | All config options and environment variables |
| [Architecture](./docs/architecture.md) | System design and data flow |
| [MCP Tools Reference](./docs/api/tools.md) | All tools available to Claude |
| [Sandbox API](./docs/api/sandbox-api.md) | The `mcp` object inside execute_code |
| [CLI Reference](./docs/cli-reference.md) | Command-line tool usage |
| [Examples](./docs/examples/) | Recipes and patterns |
| [Benchmarks](./docs/benchmarks/methodology.md) | Token savings methodology and results |
| [Security](./docs/permissions.md) | Deno sandbox permission model |
| [Troubleshooting](./docs/troubleshooting.md) | Common issues and fixes |

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
