# Tools Reference

MCP Conductor exposes the following tools to Claude. In exclusive mode, these are the only tools Claude can see. All MCP operations on backend servers happen via `execute_code`.

## execute_code

The primary tool. Runs TypeScript or JavaScript code in an isolated Deno sandbox with access to all configured MCP servers.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `code` | string | Yes | — | TypeScript or JavaScript code to execute |
| `timeout_ms` | number | No | 30000 | Execution timeout in milliseconds (max 300000) |

### Return Value

The return value of your code is serialised as JSON and sent back to Claude. Structure it to be as compact as possible — raw API responses can be hundreds of kilobytes; a filtered summary is usually tens of tokens.

### Example

```typescript
// List TypeScript files and count lines in each
const fs = mcp.server('filesystem');
const entries = await fs.call('list_directory', { path: '/Users/you/src' });
const tsFiles = entries.entries.filter(e => e.name.endsWith('.ts'));

const results = await Promise.all(
  tsFiles.map(async (f) => {
    const content = await fs.call('read_file', { path: f.path });
    const lines = content.contents.split('\n').length;
    return { file: f.name, lines };
  })
);

return results.sort((a, b) => b.lines - a.lines).slice(0, 10);
```

### Extending the Timeout

For long-running operations (large directory scans, many API calls):

```typescript
// In the tool call parameters
{ timeout_ms: 120000 }  // 2 minutes
```

### Error Handling

Uncaught errors are caught by the executor and returned as an error object. You can also handle errors explicitly:

```typescript
try {
  const result = await mcp.server('github').call('get_repository', {
    owner: 'nonexistent',
    repo: 'also-nonexistent'
  });
  return result;
} catch (err) {
  return { error: err.message, status: 'not_found' };
}
```

---

## list_servers

Lists all MCP servers currently connected to MCP Conductor, with their status and tool counts.

### Parameters

None.

### Response

```json
{
  "servers": [
    {
      "name": "github",
      "status": "connected",
      "toolCount": 26,
      "connectedAt": "2024-01-15T10:30:00Z"
    },
    {
      "name": "filesystem",
      "status": "connected",
      "toolCount": 14,
      "connectedAt": "2024-01-15T10:30:00Z"
    }
  ],
  "stats": {
    "total": 4,
    "connected": 4,
    "error": 0,
    "disconnected": 0
  }
}
```

Use this to verify that your servers loaded correctly after editing `~/.mcp-conductor.json`.

---

## discover_tools

Search for tools across all connected servers. Useful for exploring what is available before writing `execute_code` calls.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | No | — | Search term matched against tool name and description |
| `server` | string | No | — | Filter results to a specific server |

### Response

```json
{
  "tools": [
    {
      "server": "github",
      "name": "search_repositories",
      "description": "Search for GitHub repositories matching a query"
    },
    {
      "server": "github",
      "name": "search_code",
      "description": "Search code across GitHub repositories"
    }
  ],
  "totalCount": 2
}
```

### Examples

Search for file-related tools across all servers:

```json
{ "query": "file" }
```

Get all tools from a specific server:

```json
{ "server": "github" }
```

Get all tools from all servers (no filter):

```json
{}
```

---

## add_server

Add a new MCP server to the conductor configuration at runtime. The server starts connecting immediately and is available in `execute_code` within a few seconds.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Name to use in `mcp.server('name')` calls |
| `config` | object | Yes | Server configuration object |

The `config` object follows the same schema as entries in `~/.mcp-conductor.json`:

```json
{
  "name": "brave-search",
  "config": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "env": {
      "BRAVE_API_KEY": "BSA_xxxxxxxxxxxxxxxxxxxx"
    }
  }
}
```

### Response

```json
{
  "name": "brave-search",
  "status": "connecting",
  "message": "Server added. Will be available in execute_code within a few seconds."
}
```

The server is also persisted to `~/.mcp-conductor.json` so it survives restarts.

---

## remove_server

Remove a connected MCP server. The server is disconnected and removed from `~/.mcp-conductor.json`.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Name of the server to remove |

### Response

```json
{
  "name": "brave-search",
  "removed": true
}
```

---

## update_server

Update an existing server's configuration without removing and re-adding it. Useful for rotating API keys or updating a server command after a package upgrade.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Name of the server to update |
| `command` | string | No | New command |
| `args` | string[] | No | New arguments |
| `env` | object | No | Environment variables to merge (not replace) |

### Example: Rotate an API key without restart

```typescript
// Claude can call this directly, or you can ask it to run in execute_code
mcp__mcp-conductor__update_server({
  name: 'brave-search',
  env: { BRAVE_API_KEY: 'BSA_new_key_here' }
})
```

Only the fields you provide are changed. Existing fields not mentioned are preserved.

---

## get_metrics

Returns session statistics including execution count, timing, and token savings estimates.

### Parameters

None.

### Response

```json
{
  "session": {
    "startedAt": "2024-01-15T10:30:00Z",
    "executionCount": 15,
    "totalExecutionTimeMs": 4523,
    "averageExecutionTimeMs": 301
  },
  "tokenSavings": {
    "estimatedDirectCalls": 150,
    "actualCalls": 15,
    "savingsPercent": 90
  },
  "errors": {
    "count": 2,
    "lastError": "Timeout exceeded after 30000ms"
  }
}
```

`estimatedDirectCalls` is calculated based on the number of MCP server calls made inside each `execute_code` execution — each of those would have been a separate tool call in Claude's context without MCP Conductor.

---

## set_mode

Switch MCP Conductor's operating mode for the current session.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | string | Yes | One of: `execution`, `passthrough`, `hybrid` |

### Modes

| Mode | Description |
|------|-------------|
| `execution` | All MCP operations go through `execute_code`. Maximum token savings. Default. |
| `passthrough` | Direct tool calls are forwarded without code execution. Useful for debugging individual tool calls. |
| `hybrid` | Automatic selection based on task complexity (experimental). |

### Response

```json
{
  "previousMode": "execution",
  "currentMode": "passthrough",
  "message": "Mode changed successfully"
}
```

---

## compare_modes

Analyse how a described task would be handled in execution vs passthrough mode, including estimated token impact.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | Natural language description of the task to analyse |

### Response

```json
{
  "task": "List all TypeScript files and count lines in each",
  "analysis": {
    "execution": {
      "estimatedCalls": 1,
      "estimatedContextTokens": 250,
      "approach": "Single execute_code block iterates directory and files"
    },
    "passthrough": {
      "estimatedCalls": 52,
      "estimatedContextTokens": 38000,
      "approach": "One list_directory call + one read_file per file"
    },
    "recommendation": "execution",
    "reason": "Task involves iterating over many items — execution mode avoids per-item context growth"
  }
}
```

---

## reload_servers

Reload server configurations from `~/.mcp-conductor.json`. New servers connect, removed servers disconnect, changed servers restart.

### Parameters

None.

### Response

```json
{
  "added": ["new-server"],
  "removed": ["old-server"],
  "reconnected": ["changed-server"],
  "unchanged": ["github", "filesystem"],
  "message": "Reload complete"
}
```

---

## passthrough_call

Make a direct tool call to a backend server, bypassing code execution. The raw server response enters Claude's context.

::: warning High token cost
This tool exists for debugging. The raw response from any MCP server can be thousands of tokens. In normal workflows, always use `execute_code` instead.
:::

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | Yes | Name of the MCP server |
| `tool` | string | Yes | Name of the tool to call |
| `params` | object | No | Parameters for the tool |

### Example

```json
{
  "server": "github",
  "tool": "get_repository",
  "params": {
    "owner": "darkiceinteractive",
    "repo": "mcp-conductor"
  }
}
```

---

## get_capabilities

Returns information about the running MCP Conductor instance — version, features, limits, and sandbox configuration.

### Parameters

None.

### Response

```json
{
  "version": "1.0.1",
  "features": {
    "codeExecution": true,
    "streaming": true,
    "hotReload": true,
    "metrics": true
  },
  "limits": {
    "defaultTimeoutMs": 30000,
    "maxTimeoutMs": 300000,
    "maxMemoryMb": 512
  },
  "sandbox": {
    "runtime": "deno",
    "permissions": ["net=127.0.0.1"]
  }
}
```

---

## Best Practices

### Return compact results

```typescript
// Bad — returns raw API data, potentially thousands of tokens
const repos = await gh.call('search_repositories', { query: 'mcp' });
return repos;

// Good — returns only what Claude needs
const repos = await gh.call('search_repositories', { query: 'mcp' });
return repos.items.slice(0, 5).map(r => ({
  name: r.full_name,
  stars: r.stargazers_count
}));
```

### Parallelise independent calls

```typescript
// Bad — sequential, takes 3× as long
const a = await serverA.call('tool_one', {});
const b = await serverB.call('tool_two', {});
const c = await serverC.call('tool_three', {});

// Good — parallel, takes 1× as long
const [a, b, c] = await mcp.batch([
  () => serverA.call('tool_one', {}),
  () => serverB.call('tool_two', {}),
  () => serverC.call('tool_three', {}),
]);
```

### Use progress for long operations

```typescript
const files = await fs.call('list_directory', { path: '/large-project' });
const total = files.entries.length;

for (let i = 0; i < total; i++) {
  mcp.progress(`Processing ${i + 1} of ${total}: ${files.entries[i].name}`);
  await processFile(files.entries[i]);
}
```
