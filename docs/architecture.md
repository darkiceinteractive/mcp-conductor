# MCP Conductor Architecture

This document describes the internal architecture of MCP Conductor and how its components interact.

## Overview

MCP Conductor acts as a meta-MCP server that orchestrates code execution in a sandboxed Deno environment. Instead of Claude making direct tool calls to individual MCP servers (which consumes many tokens), Claude writes code that runs in an isolated sandbox. The sandbox has access to all configured MCP servers via a bridge API.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Claude Code                                  │
│                                                                      │
│  Instead of: 10 direct tool calls (high token usage)                │
│  Uses: 1 execute_code call with TypeScript (low token usage)        │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      MCP Conductor Server                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │   MCP Hub   │  │ HTTP Bridge │  │  Executor   │                 │
│  │             │  │             │  │             │                 │
│  │ Connects to │  │ localhost   │  │ Deno        │                 │
│  │ all servers │  │ only access │  │ Subprocess  │                 │
│  └─────────────┘  └─────────────┘  └─────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Connected MCP Servers                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ GitHub   │  │Filesystem│  │  Serena  │  │ Memory   │  ...      │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. MCP Server (`src/server/mcp-server.ts`)

The main entry point that implements the MCP protocol. It:

- Exposes tools like `execute_code`, `list_servers`, `discover_tools`
- Handles incoming requests from Claude Code
- Coordinates between the executor and the hub
- Manages session state and metrics

### 2. MCP Hub (`src/hub/mcp-hub.ts`)

Manages connections to all configured MCP servers. It:

- Reads Claude's configuration file to discover MCP servers
- Spawns and connects to each server via stdio transport
- Maintains a connection pool with health monitoring
- Caches tool schemas for efficient discovery
- Supports hot-reload of server configurations
- Handles reconnection with exponential backoff

**Key Features:**
- Filters out self-reference (mcp-conductor) to avoid circular connections
- Supports allow/deny lists for server filtering
- Emits events for connection state changes

### 3. HTTP Bridge (`src/bridge/http-server.ts`)

A localhost-only HTTP server that acts as a bridge between the Deno sandbox and MCP servers. It:

- Listens on a dynamically allocated port (port 0 by default)
- Only accepts connections from localhost (security)
- Provides endpoints for tool discovery and execution
- Routes requests to the appropriate MCP server via the hub

**Endpoints:**
- `POST /call` - Execute a tool on an MCP server
- `GET /servers` - List available servers
- `GET /tools/:server` - Get tools for a specific server
- `GET /health` - Health check

### 4. Executor (`src/runtime/executor.ts`)

Runs user code in an isolated Deno subprocess. It:

- Wraps user code with the `mcp` API
- Spawns Deno with strict permission flags
- Captures stdout, stderr, and return values
- Enforces timeout limits
- Provides progress reporting

**Deno Sandbox Permissions:**
```bash
deno run \
  --allow-net=127.0.0.1:${BRIDGE_PORT} \  # Only localhost bridge
  --no-prompt \                            # No permission prompts
  --v8-flags=--max-heap-size=${MAX_MB}    # Memory limit
```

### 5. Config Loader (`src/config/loader.ts`)

Handles configuration from multiple sources:

1. Default configuration
2. Config file (`~/.mcp-executor/config.json`)
3. Environment variables
4. CLI arguments

Also responsible for:
- Finding Claude's configuration file
- Loading MCP server definitions
- Cross-platform path resolution

## Data Flow

### Code Execution Flow

```
1. Claude sends execute_code request
   │
2. Server validates and prepares code
   │
3. Bridge starts listening (dynamic port)
   │
4. Executor spawns Deno subprocess
   │  - Injects mcp API wrapper
   │  - Sets bridge URL as env var
   │
5. User code runs in sandbox
   │  - mcp.server('github').call('search', {...})
   │
6. Sandbox makes HTTP request to bridge
   │
7. Bridge routes to Hub
   │
8. Hub calls actual MCP server
   │
9. Response flows back through chain
   │
10. Only final return value sent to Claude
```

### Connection Management Flow

```
1. Hub initialises
   │
2. Load Claude config file
   │
3. Filter servers (allow/deny lists)
   │
4. For each server (concurrent):
   │  - Create MCP client
   │  - Create stdio transport
   │  - Connect with timeout
   │  - Cache tools on success
   │
5. Monitor connections
   │  - Handle disconnections
   │  - Auto-reconnect with backoff
   │  - Emit state change events
```

## Security Model

### Sandbox Isolation

The Deno sandbox is configured with minimal permissions:

| Permission | Setting | Reason |
|------------|---------|--------|
| Network | localhost only | Can only reach the bridge |
| Filesystem | None | All file ops go through MCP |
| Environment | None | No access to secrets |
| Subprocess | None | Cannot spawn processes |
| FFI | None | No native code |

### Bridge Security

- Binds only to `127.0.0.1` (not `0.0.0.0`)
- Dynamic port allocation prevents port conflicts
- No authentication needed (localhost only)
- Request validation and sanitisation

### Trust Model

```
Trusted:
  - Claude Code (initiates requests)
  - MCP Conductor (orchestrates)
  - Configured MCP servers (vetted by user)

Untrusted:
  - User code in sandbox (isolated)
  - External network (blocked)
```

## Performance Optimisations

### Token Savings

Traditional approach (high tokens):
```
Tool call 1: list files → response
Tool call 2: read file 1 → response
Tool call 3: read file 2 → response
Tool call 4: process data → response
...
```

MCP Conductor approach (low tokens):
```
execute_code: {
  const files = await fs.list('/src');
  const contents = await Promise.all(
    files.map(f => fs.read(f.path))
  );
  return processData(contents);
}
→ single compact response
```

### Dynamic Port Allocation

- Default port is `0` (OS assigns available port)
- Allows multiple Claude Code sessions simultaneously
- Bridge tracks actual port after binding
- No port conflict errors

### Connection Pooling

- Hub maintains persistent connections to MCP servers
- Tool schemas cached after first fetch
- Reconnection handled automatically
- No connection overhead per request

## Extension Points

### Custom Skills (Planned)

```typescript
// skills/custom-skill.ts
export const skill = {
  name: 'data-analysis',
  description: 'Analyse data with pandas-like operations',
  execute: async (mcp, params) => {
    // Custom implementation
  }
};
```

### Mode Handlers (`src/modes/mode-handler.ts`)

Three execution modes:

1. **Execution** (default) - All through code executor
2. **Passthrough** - Direct tool calls (for debugging)
3. **Hybrid** - Automatic selection based on complexity

### Event System

The Hub emits events for integration:

```typescript
hub.on('serverConnected', (name) => { ... });
hub.on('serverDisconnected', (name, error) => { ... });
hub.on('serversChanged', (added, removed) => { ... });
hub.on('toolsCached', (name, count) => { ... });
```

## File Structure

```
src/
├── bin/
│   └── cli.ts              # Command-line interface
├── bridge/
│   ├── http-server.ts      # HTTP bridge server
│   └── index.ts
├── config/
│   ├── defaults.ts         # Default configuration
│   ├── loader.ts           # Config loading logic
│   ├── schema.ts           # TypeScript types
│   └── index.ts
├── hub/
│   ├── mcp-hub.ts          # MCP server connections
│   └── index.ts
├── metrics/
│   ├── metrics-collector.ts # Usage metrics
│   └── index.ts
├── modes/
│   ├── mode-handler.ts     # Execution mode logic
│   └── index.ts
├── runtime/
│   ├── executor.ts         # Deno subprocess runner
│   └── index.ts
├── server/
│   ├── mcp-server.ts       # Main MCP server
│   └── index.ts
├── streaming/
│   ├── execution-stream.ts # Progress streaming
│   └── index.ts
├── utils/
│   ├── errors.ts           # Error types
│   ├── helpers.ts          # Utility functions
│   ├── logger.ts           # Logging
│   ├── permissions.ts      # Permission management
│   └── index.ts
├── watcher/
│   ├── config-watcher.ts   # Hot reload
│   └── index.ts
└── index.ts                # Main exports
```

## Dependencies

### Runtime Dependencies

- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `commander` - CLI framework

### Development Dependencies

- `typescript` - Type checking
- `vitest` - Testing framework
- `eslint` + `prettier` - Code quality

### System Requirements

- Node.js 18+ (for MCP Conductor)
- Deno 1.40+ (for sandbox execution)
