# Architecture Overview

MCP Conductor acts as a meta-MCP server that orchestrates code execution in a sandboxed Deno environment. Instead of Claude making direct tool calls to individual MCP servers (high token usage), Claude writes TypeScript that runs in an isolated sandbox (low token usage).

## Component Diagram

```
Claude Code / Claude Desktop
    |
    v
+---------------------------------------------+
|           MCP Conductor Server               |
|                                              |
|  +-------------+  +-----------+  +---------+ |
|  |  MCP Server  |  |   HTTP    |  |  Deno   | |
|  |  (protocol)  |  |  Bridge   |  | Executor| |
|  +------+------+  +-----+-----+  +----+----+ |
|         |                |              |      |
+---------------------------------------------+
          |                |
          v                v
+---------+------+  +------+--------+
|    MCP Hub     |  | Config Watcher |
| (conn pool)    |  |  (hot reload)  |
+---+---+---+---+  +----------------+
    |   |   |
    v   v   v
 github  fs  brave-search  ...
```

## Core Components

### MCP Server (`src/server/mcp-server.ts`)

The main entry point implementing the MCP protocol. It:

- Exposes tools: `execute_code`, `list_servers`, `discover_tools`, `get_metrics`, etc.
- Handles incoming requests from Claude via stdio transport
- Coordinates between the executor and the hub
- Manages session state and metrics

### MCP Hub (`src/hub/mcp-hub.ts`)

Connection pool managing backend MCP server processes. It:

- Reads Claude's config or `~/.mcp-conductor.json` to discover servers
- Spawns and connects to each server via stdio transport
- Caches tool schemas for efficient discovery
- Supports hot-reload of server configurations
- Handles reconnection with exponential backoff
- Filters out self-reference to avoid circular connections

### HTTP Bridge (`src/bridge/http-server.ts`)

Localhost-only HTTP server bridging the Deno sandbox and MCP servers:

- Listens on a dynamically allocated port (port 0 by default)
- Only accepts connections from localhost
- Endpoints: `POST /call`, `GET /servers`, `GET /tools/:server`, `GET /health`

### Executor (`src/runtime/executor.ts`)

Runs user code in an isolated Deno subprocess:

- Wraps user code with the `mcp` API bridge script
- Spawns Deno with strict permission flags
- Captures stdout, stderr, and return values
- Enforces timeout limits

### Supporting Modules

| Module | Purpose |
|--------|---------|
| `src/config/` | Zod schema validation, defaults, env var overrides, config loader |
| `src/metrics/` | Token savings estimation, compression ratios, session statistics |
| `src/modes/` | Execution/passthrough/hybrid mode switching logic |
| `src/skills/` | YAML-defined reusable code templates with search/execute |
| `src/streaming/` | SSE-based progress updates and log forwarding |
| `src/watcher/` | File watcher for `~/.mcp-conductor.json` hot reload |
| `src/utils/` | Logger, error hierarchy, rate limiter, permission builder |

## Data Flow

### Code Execution Flow

```
1. Claude sends execute_code with TypeScript code
2. Server validates code and prepares execution context
3. Bridge starts listening on dynamic port
4. Executor spawns Deno subprocess with bridge URL
5. User code runs in sandbox, calling mcp.server('x').call(...)
6. Sandbox HTTP requests hit the bridge
7. Bridge routes to Hub
8. Hub calls actual MCP server via stdio
9. Response flows back: server -> hub -> bridge -> sandbox
10. Only final return value sent to Claude's context
```

### Why Deno?

| Criterion | Deno | Docker | Node.js subprocess |
|-----------|------|--------|--------------------|
| Cold start | ~50ms | 500ms-2s | ~200ms |
| Memory overhead | <50MB | 200MB+ | ~100MB |
| TypeScript | Native | Requires setup | Requires tsx/ts-node |
| Permission model | Granular | Coarse | None |
| Sandbox isolation | Built-in | Strong | Weak |

Deno provides the best combination of fast startup, low memory, native TypeScript, and granular security permissions.

## Connection Management

```
1. Hub initialises
2. Load config file (Claude config or ~/.mcp-conductor.json)
3. Filter servers (allow/deny lists, exclude self)
4. For each server (concurrent):
   - Create MCP client with stdio transport
   - Connect with timeout
   - Cache tools on success
5. Monitor connections:
   - Handle disconnections
   - Auto-reconnect with exponential backoff
   - Emit state change events
```
