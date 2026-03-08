# Configuration Guide

MCP Conductor can be configured through multiple sources, with later sources overriding earlier ones:

1. Default values
2. Configuration file
3. Environment variables
4. CLI arguments

## Quick Start

Most users don't need any configuration. MCP Conductor automatically:

- Finds your Claude configuration file
- Connects to all configured MCP servers
- Uses dynamic port allocation
- Applies sensible defaults

## Configuration File

Create `~/.mcp-executor/config.json`:

```json
{
  "bridge": {
    "port": 0,
    "host": "127.0.0.1"
  },
  "execution": {
    "mode": "execution",
    "defaultTimeoutMs": 30000,
    "maxTimeoutMs": 300000,
    "streamingEnabled": true
  },
  "sandbox": {
    "maxMemoryMb": 512,
    "allowNet": false,
    "allowRead": false,
    "allowWrite": false,
    "allowEnv": false
  },
  "servers": {
    "allowList": ["*"],
    "denyList": []
  },
  "hotReload": {
    "enabled": true,
    "debounceMs": 1000
  },
  "metrics": {
    "enabled": true,
    "retentionMinutes": 60
  }
}
```

## Environment Variables

All settings can be overridden via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_CONDUCTOR_PORT` | Bridge server port (0 = dynamic) | `0` |
| `MCP_CONDUCTOR_MODE` | Execution mode | `execution` |
| `MCP_CONDUCTOR_TIMEOUT` | Default timeout (ms) | `30000` |
| `MCP_CONDUCTOR_MAX_TIMEOUT` | Maximum timeout (ms) | `300000` |
| `MCP_CONDUCTOR_LOG_LEVEL` | Log level | `info` |
| `MCP_CONDUCTOR_CLAUDE_CONFIG` | Path to Claude config | auto-detect |
| `MCP_CONDUCTOR_SKILLS_PATH` | Path to skills directory | none |
| `MCP_CONDUCTOR_WATCH_CONFIG` | Enable hot reload | `true` |
| `MCP_CONDUCTOR_WATCH_SKILLS` | Watch skills for changes | `true` |
| `MCP_CONDUCTOR_STREAM_ENABLED` | Enable streaming | `true` |
| `MCP_CONDUCTOR_MAX_MEMORY_MB` | Sandbox memory limit | `512` |
| `MCP_CONDUCTOR_ALLOWED_SERVERS` | Comma-separated allow list | `*` |

## Configuration Options

### Bridge Settings

```json
{
  "bridge": {
    "port": 0,
    "host": "127.0.0.1"
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | `0` | Port for HTTP bridge. Use `0` for dynamic allocation (recommended) |
| `host` | string | `127.0.0.1` | Host to bind to. Always use localhost for security |

**Port 0 (Dynamic Allocation):**
- OS assigns an available port automatically
- Allows multiple Claude Code sessions simultaneously
- No port conflict errors
- Recommended for all users

### Execution Settings

```json
{
  "execution": {
    "mode": "execution",
    "defaultTimeoutMs": 30000,
    "maxTimeoutMs": 300000,
    "streamingEnabled": true
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | string | `execution` | Execution mode: `execution`, `passthrough`, or `hybrid` |
| `defaultTimeoutMs` | number | `30000` | Default timeout for code execution |
| `maxTimeoutMs` | number | `300000` | Maximum allowed timeout |
| `streamingEnabled` | boolean | `true` | Enable progress streaming |

**Execution Modes:**

- **`execution`** (default): All requests go through the code executor. Maximum token savings.
- **`passthrough`**: Direct tool calls without code execution. Useful for debugging.
- **`hybrid`**: Automatic selection based on task complexity.

### Sandbox Settings

```json
{
  "sandbox": {
    "maxMemoryMb": 512,
    "allowNet": false,
    "allowRead": false,
    "allowWrite": false,
    "allowEnv": false
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxMemoryMb` | number | `512` | Maximum heap memory for Deno subprocess |
| `allowNet` | boolean | `false` | Allow network access (beyond bridge) |
| `allowRead` | boolean | `false` | Allow filesystem read access |
| `allowWrite` | boolean | `false` | Allow filesystem write access |
| `allowEnv` | boolean | `false` | Allow environment variable access |

**Security Note:** The default sandbox settings are intentionally restrictive. All file and network operations should go through MCP servers, not direct Deno permissions.

### Server Filtering

```json
{
  "servers": {
    "allowList": ["*"],
    "denyList": ["problematic-server"]
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowList` | string[] | `["*"]` | Servers to connect to. `*` means all |
| `denyList` | string[] | `[]` | Servers to exclude |

**Examples:**

Connect to all servers:
```json
{ "allowList": ["*"], "denyList": [] }
```

Connect to specific servers only:
```json
{ "allowList": ["github", "filesystem"], "denyList": [] }
```

Connect to all except some:
```json
{ "allowList": ["*"], "denyList": ["slow-server", "broken-server"] }
```

**Note:** `mcp-conductor` is always excluded to prevent circular connections.

### Hot Reload Settings

```json
{
  "hotReload": {
    "enabled": true,
    "debounceMs": 1000
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Watch Claude config for changes |
| `debounceMs` | number | `1000` | Debounce time for file changes |

When enabled, MCP Conductor will automatically:
- Detect changes to Claude's configuration file
- Connect to newly added servers
- Disconnect from removed servers
- Reconnect servers with changed configurations

### Metrics Settings

```json
{
  "metrics": {
    "enabled": true,
    "retentionMinutes": 60
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Collect usage metrics |
| `retentionMinutes` | number | `60` | How long to keep metrics |

Metrics include:
- Execution count and duration
- Token savings estimates
- Error rates
- Server connection stats

## Claude Desktop Configuration

MCP Conductor reads MCP server definitions from Claude's configuration file.

**Location:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/claude/claude_desktop_config.json`

**Claude Code:** `~/.claude.json`

**Example configuration:**

```json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "node",
      "args": ["/path/to/mcp-conductor/dist/index.js"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxx"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-filesystem", "/Users/me/projects"]
    }
  }
}
```

## Programmatic Configuration

For embedding MCP Conductor in your own application:

```typescript
import { MCPExecutorServer, loadConfig } from '@darkice/mcp-conductor';

// Load config with overrides
const config = loadConfig();
config.bridge.port = 9999;
config.execution.mode = 'hybrid';

// Create and start server
const server = new MCPExecutorServer(config);
await server.start();

// Shutdown
await server.stop();
```

## Configuration Precedence

When the same setting is specified in multiple places:

```
CLI arguments (highest priority)
    ↓
Environment variables
    ↓
Configuration file
    ↓
Default values (lowest priority)
```

**Example:**

```bash
# Default port is 0
# Config file sets port to 8080
# This CLI argument wins:
node dist/bin/cli.js serve --port 9000
```

## Troubleshooting

### Config file not found

```bash
node dist/bin/cli.js status
```

Shows the config file being used and search paths.

### Server not connecting

Check the deny list:
```json
{
  "servers": {
    "denyList": []  // Remove any blocking entries
  }
}
```

### Timeout errors

Increase the timeout:
```json
{
  "execution": {
    "defaultTimeoutMs": 60000,
    "maxTimeoutMs": 600000
  }
}
```

### Memory errors

Increase sandbox memory:
```json
{
  "sandbox": {
    "maxMemoryMb": 1024
  }
}
```
