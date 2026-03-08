# Configuration Guide

MCP Conductor can be configured through multiple sources, with later sources overriding earlier ones:

1. Default values
2. Configuration file (`~/.mcp-conductor.json`)
3. Environment variables

Most users don't need any configuration. MCP Conductor automatically finds your Claude config, connects to all configured servers, uses dynamic port allocation, and applies sensible defaults.

## The Config File

Create `~/.mcp-conductor.json`:

```json
{
  "exclusive": true,
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "your-token" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you"],
      "env": {}
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
    }
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_EXECUTOR_PORT` | Bridge server port (0 = dynamic) | `0` |
| `MCP_EXECUTOR_MODE` | Execution mode | `execution` |
| `MCP_EXECUTOR_TIMEOUT` | Default timeout (ms) | `30000` |
| `MCP_EXECUTOR_MAX_TIMEOUT` | Maximum timeout (ms) | `300000` |
| `MCP_EXECUTOR_LOG_LEVEL` | Log level (debug/info/warn/error) | `info` |
| `MCP_EXECUTOR_CONFIG` | Path to config file | auto-detect |
| `MCP_EXECUTOR_CLAUDE_CONFIG` | Path to Claude config | auto-detect |
| `MCP_CONDUCTOR_CONFIG` | Path to conductor config | `~/.mcp-conductor.json` |
| `MCP_EXECUTOR_SKILLS_PATH` | Path to skills directory | none |
| `MCP_EXECUTOR_WATCH_CONFIG` | Enable hot reload | `true` |
| `MCP_EXECUTOR_STREAM_ENABLED` | Enable streaming | `true` |
| `MCP_EXECUTOR_MAX_MEMORY_MB` | Sandbox memory limit | `512` |
| `MCP_EXECUTOR_ALLOWED_SERVERS` | Comma-separated allow list | `*` |

## Configuration Options

### Bridge Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bridge.port` | number | `0` | Port for HTTP bridge. `0` = dynamic (recommended) |
| `bridge.host` | string | `127.0.0.1` | Host to bind to. Always use localhost |

### Execution Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `execution.mode` | string | `execution` | `execution`, `passthrough`, or `hybrid` |
| `execution.defaultTimeoutMs` | number | `30000` | Default execution timeout |
| `execution.maxTimeoutMs` | number | `300000` | Maximum allowed timeout |
| `execution.streamingEnabled` | boolean | `true` | Enable progress streaming |

### Sandbox Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sandbox.maxMemoryMb` | number | `512` | Maximum Deno subprocess heap memory |
| `sandbox.allowedNetHosts` | string[] | `["localhost"]` | Permitted network hosts |

### Server Filtering

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `servers.allowList` | string[] | `["*"]` | Servers to connect to. `*` = all |
| `servers.denyList` | string[] | `[]` | Servers to exclude |

`mcp-conductor` is always excluded from the connection list to prevent circular connections.

### Hot Reload

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `hotReload.enabled` | boolean | `true` | Watch config for changes |
| `hotReload.debounceMs` | number | `500` | Debounce time for file changes |

### Metrics

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `metrics.enabled` | boolean | `true` | Collect usage metrics |
| `metrics.logToFile` | boolean | `false` | Write metrics to file |
| `metrics.logPath` | string | `null` | Path for metrics log file |

### Skills

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `skills.path` | string | `null` | Path to skills directory |
| `skills.watchForChanges` | boolean | `true` | Hot-reload skill files |

## Rate Limiting (Per Server)

Add a `rateLimit` block to any server definition:

```json
{
  "rateLimit": {
    "requestsPerSecond": 20,
    "burstSize": 20,
    "onLimitExceeded": "queue",
    "maxQueueTimeMs": 30000
  }
}
```

| Option | Description |
|--------|-------------|
| `requestsPerSecond` | Sustained request rate |
| `burstSize` | Maximum burst above sustained rate |
| `onLimitExceeded` | `"queue"` (buffer) or `"reject"` (fail immediately) |
| `maxQueueTimeMs` | Maximum time a request waits in queue before rejection |

## Configuration Precedence

```
Environment variables (highest priority)
    |
Configuration file (~/.mcp-conductor.json)
    |
Default values (lowest priority)
```

## Claude Config File Locations

MCP Conductor auto-detects the Claude config:

- **Claude Code:** `~/.claude/settings.json`
- **Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`
- **Claude Desktop (Linux):** `~/.config/claude/claude_desktop_config.json`
