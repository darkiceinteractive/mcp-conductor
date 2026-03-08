# API Internals

This page traces the full execution lifecycle inside MCP Conductor, from Claude's tool call to the final result. Intended for contributors and advanced users who want to understand the internal architecture.

## Execution Lifecycle

### 1. Tool Call Arrives

Claude sends an `execute_code` call via the MCP protocol. The MCP server (`src/server/mcp-server.ts`) receives it as a `tools/call` request.

### 2. Mode Router

The mode router (`src/modes/`) determines how to handle the request:

- **Execution mode** → route to the Deno sandbox
- **Passthrough mode** → forward directly to the backend server
- **Hybrid mode** → analyse task complexity, then choose

### 3. Sandbox Execution

For execution mode (the default path):

```
Claude → MCP Server → Mode Router → Executor → Deno Subprocess
                                                      ↕
                                              HTTP Bridge (localhost)
                                                      ↕
                                              MCP Hub → Backend Servers
```

#### 3a. Code Generation

The executor (`src/runtime/executor.ts`) wraps user code in a sandbox template:

1. Injects the `mcp` API object (server handles, batch, progress, etc.)
2. Sets up metrics tracking (tool calls, data bytes)
3. Configures console.log capture
4. Adds rate limit detection and retry logic
5. Wraps in a top-level async function with error boundaries

#### 3b. Deno Subprocess

A Deno process is spawned with locked-down permissions:

```bash
deno run \
  --allow-net=127.0.0.1 \
  --no-prompt \
  /tmp/mcp-exec-{id}.ts
```

The subprocess communicates with the bridge via HTTP on localhost.

#### 3c. Bridge Communication

When sandbox code calls `mcp.server('github').call('search_repositories', {...})`:

1. The `mcp` API sends a POST to `http://127.0.0.1:{port}/call`
2. The bridge (`src/bridge/http-server.ts`) receives the request
3. The bridge calls the `callTool` handler registered by the MCP hub
4. The hub routes to the correct backend MCP server
5. The response flows back: hub → bridge → sandbox

#### 3d. Result Collection

When execution completes:

1. The sandbox's return value is serialised as JSON
2. Stdout is parsed for the result delimiter
3. Stderr logs are collected
4. The temporary file is cleaned up

### 4. Metrics Recording

The metrics collector (`src/metrics/metrics-collector.ts`) records:

- Execution duration
- Tool calls made
- Data processed (bytes)
- Result size
- Token savings estimate (execution vs passthrough)

### 5. Response to Claude

The MCP server formats the result as MCP `tools/call` response content:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{...compact JSON result...}"
    }
  ]
}
```

Only this compact result enters Claude's context window.

## Hub Connection Pool

The hub (`src/hub/`) manages connections to all backend MCP servers:

### Connection Lifecycle

1. **Config loaded** → hub reads server definitions
2. **Connection attempt** → spawn MCP server process, establish stdio transport
3. **Tool discovery** → query each server for available tools
4. **Ready** → server added to the active pool
5. **Error/disconnect** → exponential backoff retry

### Rate Limiting Integration

The hub integrates with per-server rate limiters:

1. Before routing a tool call, check the rate limiter
2. If tokens available → proceed immediately
3. If no tokens and `queue` mode → wait for a token (up to `maxQueueTimeMs`)
4. If no tokens and `reject` mode → throw `RateLimitError`

## Bridge Routes

| Method | Path | Handler |
|--------|------|---------|
| `POST` | `/call` | Route tool call to MCP server via hub |
| `GET` | `/servers` | List connected servers |
| `GET` | `/tools/:server` | List tools for a server |
| `GET` | `/search-tools` | Search tools across all servers |
| `POST` | `/progress` | Report progress from sandbox |
| `POST` | `/log` | Report log message from sandbox |
| `POST` | `/tool-event` | Report tool call event from sandbox |
| `GET` | `/stream/:id` | SSE stream for execution events |

## Config File Watcher

The watcher (`src/watcher/`) monitors `~/.mcp-conductor.json`:

1. Uses `fs.watch()` with 500ms debounce
2. On change: re-reads config, diffs against current state
3. New servers → connect
4. Removed servers → disconnect
5. Changed servers → reconnect
6. Unchanged servers → leave alone
7. Emits `serversChanged` event

## Streaming Pipeline

```
Sandbox console.log() → Bridge /log endpoint → StreamManager → SSE clients
Sandbox mcp.progress() → Bridge /progress endpoint → StreamManager → SSE clients
Bridge tool call → Bridge /tool-event endpoint → StreamManager → SSE clients
```

The `ExecutionStream` class manages per-execution state with a 100-event buffer for late-connecting clients.

## Error Flow

Errors at any stage are caught and categorised:

| Error Type | Source | MCP Response |
|------------|--------|-------------|
| `SyntaxError` | Deno compilation | `isError: true` with syntax details |
| `RuntimeError` | Sandbox execution | `isError: true` with stack trace |
| `TimeoutError` | Execution exceeded limit | `isError: true` with timeout info |
| `ConnectionError` | Backend server unreachable | `isError: true` with server name |
| `RateLimitError` | Rate limit rejected | `isError: true` with retry info |
