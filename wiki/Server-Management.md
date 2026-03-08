# Server Management

MCP Conductor manages connections to backend MCP servers. You can add, remove, update, and reload servers both via config file and at runtime.

## Config File

Backend servers are defined in `~/.mcp-conductor.json`:

```json
{
  "exclusive": true,
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you"],
      "env": {}
    }
  }
}
```

## Adding Servers at Runtime

Use the `add_server` tool:

```json
{
  "name": "brave-search",
  "config": {
    "command": "npx",
    "args": ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
    "env": { "BRAVE_API_KEY": "BSA_xxx" }
  }
}
```

The server starts connecting immediately and is persisted to `~/.mcp-conductor.json`.

## Removing Servers

Use `remove_server`:

```json
{ "name": "brave-search" }
```

The server is disconnected and removed from the config file.

## Updating Servers

Use `update_server` to change config without removing and re-adding:

```json
{
  "name": "brave-search",
  "env": { "BRAVE_API_KEY": "BSA_new_key" }
}
```

Only provided fields are changed. Existing fields are preserved. The server reconnects with the new configuration.

## Hot Reload

MCP Conductor watches `~/.mcp-conductor.json` for changes. When you edit and save the file:

1. New servers are connected
2. Removed servers are disconnected
3. Changed servers are reconnected
4. Unchanged servers are left alone

Changes apply in ~500ms with debouncing. No restart needed.

Disable with:
```json
{ "hotReload": { "enabled": false } }
```

## Manual Reload

Use the `reload_servers` tool to trigger a reload:

```json
{
  "added": ["new-server"],
  "removed": ["old-server"],
  "reconnected": ["changed-server"],
  "unchanged": ["github", "filesystem"]
}
```

## Server Filtering

Control which servers MCP Conductor connects to:

```json
{
  "servers": {
    "allowList": ["github", "filesystem"],
    "denyList": []
  }
}
```

- `allowList: ["*"]` — connect to all servers (default)
- `denyList: ["slow-server"]` — exclude specific servers
- `mcp-conductor` is always excluded to prevent circular connections

## Connection States

| Status | Description |
|--------|-------------|
| `connecting` | Initial connection in progress |
| `connected` | Active and ready for tool calls |
| `disconnected` | Cleanly disconnected |
| `error` | Connection failed, will retry |

## Reconnection

Failed connections are retried with exponential backoff. The hub monitors all connections and emits events on state changes:

- `serverConnected` — a server successfully connected
- `serverDisconnected` — a server disconnected (with error info)
- `serversChanged` — servers were added or removed via reload

## Checking Status

Use `list_servers` to see all connected servers:

```json
{
  "servers": [
    { "name": "github", "status": "connected", "toolCount": 26 },
    { "name": "filesystem", "status": "connected", "toolCount": 14 }
  ],
  "stats": { "total": 2, "connected": 2, "error": 0, "disconnected": 0 }
}
```
