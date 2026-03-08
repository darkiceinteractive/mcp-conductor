# Streaming & Progress

MCP Conductor supports real-time streaming of execution progress via Server-Sent Events (SSE). This allows clients to monitor long-running sandbox executions as they happen.

## Overview

When code runs in the Deno sandbox, it can emit progress updates and log messages that stream back to connected clients in real-time. These events do not consume context tokens — they are delivered out-of-band via SSE.

## Event Types

| Type | Description |
|------|-------------|
| `log` | Console output from sandbox code |
| `progress` | Percentage progress update with optional message |
| `tool_call` | Tool call started, completed, or errored |
| `error` | Execution error occurred |
| `complete` | Execution finished (success or failure) |

## Using `mcp.progress()` in Sandbox Code

Stream progress messages back to Claude while execution continues:

```typescript
mcp.progress('Fetching repository list...');
const repos = await gh.call('search_repositories', { query: 'mcp' });
mcp.progress(`Found ${repos.total_count} repos. Processing...`);

for (let i = 0; i < repos.items.length; i++) {
  mcp.progress(`Processing repo ${i + 1}/${repos.items.length}`);
  // ... process each repo
}
```

Progress messages appear in Claude's response stream as the code runs.

## Using `console.log()` in Sandbox Code

`console.log` calls are captured and surfaced as `log` events:

```typescript
console.log('Starting analysis...');
const data = await fs.call('read_file', { path: '/data.json' });
console.log(`Read ${data.contents.length} bytes`);
```

## SSE Event Format

Events are delivered as standard SSE with JSON payloads:

```
event: progress
data: {"type":"progress","timestamp":"2026-01-15T10:30:00Z","executionId":"exec_abc123","data":{"percent":50,"message":"Processing..."}}

event: tool_call
data: {"type":"tool_call","timestamp":"2026-01-15T10:30:01Z","executionId":"exec_abc123","data":{"server":"github","tool":"search_repositories","status":"completed","durationMs":234}}

event: complete
data: {"type":"complete","timestamp":"2026-01-15T10:30:02Z","executionId":"exec_abc123","data":{"success":true,"metrics":{"executionTimeMs":2100,"toolCalls":3,"dataProcessedBytes":45000}}}
```

## Bridge SSE Endpoints

The HTTP bridge exposes SSE endpoints on localhost:

| Endpoint | Description |
|----------|-------------|
| `GET /stream/:executionId` | Subscribe to events for a specific execution |
| `POST /progress` | Report progress from sandbox (used internally) |
| `POST /log` | Report log messages from sandbox (used internally) |
| `POST /tool-event` | Report tool call events from sandbox (used internally) |

## Execution State

Each execution tracks its state:

| Status | Description |
|--------|-------------|
| `running` | Execution in progress |
| `completed` | Finished successfully |
| `error` | Finished with error |
| `timeout` | Exceeded time limit |

State includes: progress percentage, log buffer, tool call count, and timing information.

## Event Buffering

The stream manager maintains a buffer of the last 100 events per execution. Late-connecting clients receive the buffered history before switching to live events. This ensures no events are missed if the SSE connection is established after execution begins.

## Connection Management

- Multiple clients can subscribe to the same execution
- Connections are cleaned up automatically when the execution completes
- The bridge only accepts connections from `127.0.0.1` (sandbox isolation)
- SSE connections use standard `text/event-stream` content type
