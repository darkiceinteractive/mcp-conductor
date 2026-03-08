# MCP Tools Reference

MCP Conductor exposes the following tools to Claude. In exclusive mode, these are the only tools Claude can see. All MCP operations on backend servers happen via `execute_code`.

## execute_code

The primary tool. Runs TypeScript in an isolated Deno sandbox with access to all configured MCP servers.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `code` | string | Yes | — | TypeScript or JavaScript code to execute |
| `timeout_ms` | number | No | 30000 | Execution timeout in milliseconds (max 300000) |

The return value of your code is serialised as JSON and sent back to Claude. Structure it to be as compact as possible.

```typescript
const fs = mcp.server('filesystem');
const entries = await fs.call('list_directory', { path: '/src' });
const tsFiles = entries.entries.filter(e => e.name.endsWith('.ts'));
return tsFiles.map(f => ({ name: f.name, size: f.size }));
```

## list_servers

Lists all connected backend servers with status and tool counts. No parameters.

```json
{
  "servers": [
    { "name": "github", "status": "connected", "toolCount": 26 },
    { "name": "filesystem", "status": "connected", "toolCount": 14 }
  ],
  "stats": { "total": 4, "connected": 4, "error": 0 }
}
```

## discover_tools

Search for tools across all connected servers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Search term for tool name/description |
| `server` | string | No | Filter to a specific server |

```json
{ "tools": [{ "server": "github", "name": "search_repositories", "description": "..." }], "totalCount": 1 }
```

## add_server

Add a new MCP server at runtime. Persisted to `~/.mcp-conductor.json`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Server name for `mcp.server('name')` |
| `config` | object | Yes | Server config (command, args, env) |

## remove_server

Remove a connected server. Disconnects and removes from config.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Server name to remove |

## update_server

Update an existing server's configuration without removing it. Only provided fields are changed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Server to update |
| `command` | string | No | New command |
| `args` | string[] | No | New arguments |
| `env` | object | No | Environment variables to merge |

## get_metrics

Returns session statistics including execution count, timing, and token savings. No parameters.

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

## set_mode

Switch operating mode for the current session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | string | Yes | `execution`, `passthrough`, or `hybrid` |

## compare_modes

Analyse how a task would run in execution vs passthrough mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | Natural language task description |

## reload_servers

Reload server configurations from `~/.mcp-conductor.json`. No parameters. Returns lists of added, removed, reconnected, and unchanged servers.

## passthrough_call

Direct tool call bypassing the sandbox. **High token cost — debug only.**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | Yes | MCP server name |
| `tool` | string | Yes | Tool name |
| `params` | object | No | Tool parameters |

## get_capabilities

Returns version, features, limits, and sandbox configuration. No parameters.

## Best Practices

1. **Return compact results** — Filter and summarise inside the sandbox rather than returning raw API data
2. **Use `mcp.batch()`** — Parallelise independent calls for speed
3. **Use `mcp.progress()`** — Stream progress for long operations
4. **Handle errors** — Wrap unreliable calls in try/catch and return structured error info
