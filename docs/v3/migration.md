# MCP Conductor v2 → v3 Migration Guide

## Breaking Changes

### 1. Package version
```json
{ "version": "3.0.0-beta.1" }
```
Install the beta: `npm install @darkiceinteractive/mcp-conductor@next`

### 2. Registry startup
v3 initialises a `ToolRegistry` on startup and calls `registry.refresh()` after
connecting to all servers. This adds ~100–500ms to startup time depending on the
number of configured servers. No config change required.

### 3. `callTool` may return `TokenizedCallResult`
If a tool has `redact.response` annotations, `callTool` now returns:
```typescript
{ __x4_result: unknown; __x4_reverseMap: Map<string, string> }
```
The HTTP bridge unwraps this transparently. Sandbox code using `mcp.callTool`
receives the already-detokenised result. **No sandbox code changes required.**

### 4. `execute_code` sandbox API additions
New `mcp` helpers available (backwards compatible — existing code still works):

```typescript
// v2 (still works)
const result = await mcp.callTool('drive', 'getFile', { fileId });

// v3 additions
const compact   = await mcp.compact(largeObject);
const summary   = await mcp.summarize(text, { maxTokens: 500 });
const tools     = await mcp.findTool('search for files');
const tokenized = await mcp.tokenize(text, ['email', 'phone']);
await mcp.budget(50_000);  // enforce token budget
```

### 5. Error types
Phase 3 replaces raw `Error` throws from the hub with typed error classes:
```typescript
import { MCPToolError, TimeoutError, CircuitOpenError } from '@darkiceinteractive/mcp-conductor/reliability';

try {
  await mcp.callTool('server', 'tool', {});
} catch (err) {
  if (err instanceof MCPToolError) { /* upstream error */ }
  if (err instanceof TimeoutError) { /* call timed out */ }
  if (err instanceof CircuitOpenError) { /* circuit open */ }
}
```

### 6. Config additions (all optional)
New top-level sections in `~/.mcp-conductor.json`:
```json
{
  "reliability": {
    "timeoutMs": 10000,
    "retries": 3,
    "circuitBreakerThreshold": 0.5
  },
  "cache": {
    "maxItems": 1000,
    "ttlMs": 300000
  },
  "observability": {
    "enabled": true,
    "costPredictor": true,
    "hotPath": true,
    "anomalyDetector": true
  },
  "daemon": {
    "enabled": false,
    "kvPath": "~/.mcp-conductor-kv.json"
  }
}
```

## Non-Breaking Additions

The following are purely additive and require no migration:
- `routing` annotations on tools (opt-in per tool)
- `redact` annotations (opt-in per tool)
- Passthrough tools auto-registered from registry annotations
- Lifecycle MCP tools (`import_servers_from_claude`, etc.)
- Daemon mode (disabled by default)
- Observability (enabled by default, read-only)

## Recommended Migration Steps

1. Update to `@next`: `npm install @darkiceinteractive/mcp-conductor@next`
2. Restart Conductor
3. Run `diagnose_server` on each server to confirm connectivity
4. Optionally add `routing` annotations to high-volume passthrough tools
5. Optionally add `redact` annotations to tools returning PII
