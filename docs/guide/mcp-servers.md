# MCP Servers

MCP Conductor is a multiplier: the more MCP servers you connect, the more powerful your sandbox code becomes. This page lists servers worth installing, their token costs, and how to configure them.

## What MCP Servers Are

An MCP server is a process that exposes tools over the Model Context Protocol. Tools do things like read files, query APIs, search the web, or interact with web browsers. Each server handles a specific domain.

Without MCP Conductor, every server's tools appear directly in Claude's tool list. With MCP Conductor in exclusive mode, all servers are hidden — they live inside the sandbox, accessible only via `mcp.server('name').call('tool', params)`. Claude never sees the tool schemas; it only sees `execute_code`.

## Servers Worth Installing

| Server | npm Package | Purpose | API Key? |
|--------|------------|---------|----------|
| **github** | `@modelcontextprotocol/server-github` | Repos, issues, PRs, code search, file access | Yes (GitHub token) |
| **filesystem** | `@modelcontextprotocol/server-filesystem` | Read/write local files and directories | No |
| **brave-search** | `@modelcontextprotocol/server-brave-search` | Web search with structured results | Yes (Brave API) |
| **playwright** | `@playwright/mcp` | Full browser automation, screenshots, scraping | No |
| **memory** | `@modelcontextprotocol/server-memory` | Knowledge graph: entities, relations, observations | No |
| **clickup** | `@taazkareem/clickup-mcp-server` | Tasks, spaces, lists, time tracking | Yes (ClickUp API) |
| **context7** | `@upstash/context7-mcp` | Up-to-date library documentation lookup | No |
| **sequential-thinking** | `@modelcontextprotocol/server-sequential-thinking` | Structured multi-step reasoning tool | No |
| **taskmaster-ai** | `task-master-ai` | AI-powered task management and decomposition | Yes (Anthropic key) |
| **serena** | `serena` (uvx) | Language-aware code intelligence, LSP integration | No |
| **deepcontext** | `deepcontext-mcp` | Deep codebase analysis and semantic search | No |
| **memory-bank** | `memory-bank-mcp` | Persistent file-based memory across sessions | No |

## Token Cost of Each Server

In passthrough mode, every server's tool schemas are loaded into Claude's context. The table below shows approximate schema sizes — a key reason exclusive mode matters.

| Server | Approx. Tool Count | Approx. Schema Tokens | Notes |
|--------|-------------------|----------------------|-------|
| github | 26 | ~4,200 | Large API surface |
| filesystem | 14 | ~1,800 | Moderate |
| brave-search | 2 | ~400 | Small |
| playwright | 20+ | ~3,500 | Browser automation schemas are verbose |
| memory | 6 | ~900 | Moderate |
| clickup | 30+ | ~5,000 | Large API surface |
| context7 | 2 | ~350 | Small |
| sequential-thinking | 1 | ~250 | Tiny |
| taskmaster-ai | 15+ | ~2,800 | Moderate |
| serena | 25+ | ~4,000 | LSP schemas are detailed |
| deepcontext | 8 | ~1,200 | Moderate |
| memory-bank | 5 | ~700 | Small |

With 6 servers connected in passthrough mode, you might load 15,000+ tokens of tool schemas before Claude has done anything. In exclusive mode, none of these schemas appear in context — you pay 0 tokens per session for server discovery.

## Configuration Examples

### GitHub

Get a personal access token from [github.com/settings/tokens](https://github.com/settings/tokens). The `repo` scope is sufficient for most tasks; add `read:org` for organisation access.

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_TOKEN": "ghp_xxxxxxxxxxxxxxxxxxxx"
    }
  }
}
```

Inside the sandbox:

```typescript
const gh = mcp.server('github');
const results = await gh.call('search_repositories', {
  query: 'language:typescript stars:>500 topic:mcp'
});
return results.items.slice(0, 5).map(r => ({
  name: r.full_name,
  stars: r.stargazers_count,
  url: r.html_url
}));
```

### Filesystem

Pass the directories you want the server to access as additional arguments. Multiple paths are supported.

```json
{
  "filesystem": {
    "command": "npx",
    "args": [
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/Users/you/projects",
      "/Users/you/documents"
    ]
  }
}
```

Inside the sandbox:

```typescript
const fs = mcp.server('filesystem');
const entries = await fs.call('list_directory', { path: '/Users/you/projects/myapp/src' });
const tsFiles = entries.entries.filter(e => e.name.endsWith('.ts'));
return { count: tsFiles.length, files: tsFiles.map(f => f.name) };
```

### Brave Search

Get a free API key from [brave.com/search/api](https://brave.com/search/api/). The free tier allows 2,000 queries/month.

```json
{
  "brave-search": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "env": {
      "BRAVE_API_KEY": "BSA_xxxxxxxxxxxxxxxxxxxx"
    },
    "rateLimit": {
      "requestsPerSecond": 1,
      "burstSize": 2,
      "onLimitExceeded": "queue",
      "maxQueueTimeMs": 60000
    }
  }
}
```

Inside the sandbox with parallel search and rate limit handling:

```typescript
const brave = mcp.server('brave-search');
const queries = ['TypeScript MCP servers 2024', 'Deno sandbox security', 'Claude Code extensions'];

// mcp.batch respects rateLimit config automatically
const results = await mcp.batch(
  queries.map(q => () => brave.call('brave_web_search', { query: q, count: 3 }))
);

return queries.map((q, i) => ({
  query: q,
  topResult: results[i]?.results?.[0]?.title ?? 'No results'
}));
```

### Playwright

No configuration beyond install — useful for browser automation, screenshot capture, and scraping pages that require JavaScript.

```json
{
  "playwright": {
    "command": "npx",
    "args": ["-y", "@playwright/mcp"]
  }
}
```

### Memory

Persistent knowledge graph across an entire Claude session. Useful for building up context incrementally across many `execute_code` calls.

```json
{
  "memory": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"]
  }
}
```

### Serena

Language-aware code intelligence server. Requires `uvx` (from the Python `uv` package manager). Provides LSP-quality symbol lookup, definition finding, and reference search for a specific project.

```json
{
  "serena": {
    "command": "uvx",
    "args": ["serena", "--project-dir", "/Users/you/projects/my-project"]
  }
}
```

## Configuration Philosophy

**Start minimal.** Add servers as you need them. Each additional server:
- Adds startup time as MCP Conductor connects to it
- Adds potential for connection failures to delay sandbox readiness
- Consumes a small amount of memory for the server process

A good starting set for most developers is: `github` + `filesystem` + `memory`. Add `brave-search` when research tasks come up. Add `playwright` when you need browser automation.

**Use rate limits.** Any server with a free-tier API should have a `rateLimit` block. MCP Conductor will queue requests automatically so your batch operations don't hit rate limits mid-execution.

**Keep secrets in `env`.** API keys in the `env` block are scoped to the server process. They are never written to Claude's context, never logged by MCP Conductor, and never appear in `execute_code` return values unless your code explicitly returns them (which you should not do).
