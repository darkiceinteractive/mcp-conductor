# MCP Conductor v3 Sandbox API Reference

The `mcp` object is available inside all `execute_code` scripts.

## Core: `mcp.callTool`

```typescript
const result = await mcp.callTool(
  server: string,
  tool: string,
  params: Record<string, unknown>
): Promise<unknown>
```

Calls an upstream MCP tool via the reliability gateway (timeout + retry + circuit breaker).
Throws `MCPToolError` on non-retryable upstream errors.

**PII note**: If the tool has `redact.response` annotations, responses are tokenised
before reaching the sandbox. Use `mcp.detokenize()` to restore original values.

## PII: `mcp.tokenize` / `mcp.detokenize`

```typescript
const { tokenized, reverseMap } = await mcp.tokenize(
  text: string,
  matchers: Array<'email' | 'phone' | 'credit_card' | 'ssn' | 'ip_address' | 'date_of_birth' | string>
): Promise<{ tokenized: string; reverseMap: Map<string, string> }>

const restored = await mcp.detokenize(
  tokenized: string,
  reverseMap: Map<string, string>
): Promise<string>
```

Tokenise PII in a string. Built-in matchers or custom regex patterns.

**Example**:
```typescript
const { tokenized, reverseMap } = await mcp.tokenize(
  'Customer john@example.com called from 555-1234',
  ['email', 'phone']
);
// tokenized: 'Customer <email:1a2b3c> called from <phone:4d5e6f>'

const restored = await mcp.detokenize(tokenized, reverseMap);
// 'Customer john@example.com called from 555-1234'
```

## Context: `mcp.compact` / `mcp.summarize`

```typescript
const compacted = await mcp.compact(
  data: unknown,
  opts?: { maxBytes?: number }
): Promise<unknown>

const summary = await mcp.summarize(
  text: string,
  opts?: { maxTokens?: number; format?: 'bullets' | 'paragraph' }
): Promise<string>
```

Reduce data size before returning it to the Claude context window.

## Discovery: `mcp.findTool`

```typescript
const tools = await mcp.findTool(
  query: string,
  opts?: { limit?: number; threshold?: number }
): Promise<Array<{ server: string; tool: string; score: number; description: string }>>
```

Fuzzy-search all upstream tools by name or description.

**Example**:
```typescript
const results = await mcp.findTool('search for files');
// [{ server: 'google-drive', tool: 'search_files', score: 0.92, ... }]
```

## Budget: `mcp.budget`

```typescript
await mcp.budget(
  maxTokens: number
): Promise<void>
```

Sets a token budget for the current execution. Throws `BudgetExceededError` if the
estimated output tokens would exceed `maxTokens`.

## Shared state (Daemon mode): `mcp.shared`

Only available when daemon mode is enabled (`"daemon": { "enabled": true }`).

```typescript
await mcp.shared.set(key: string, value: unknown): Promise<void>
await mcp.shared.get(key: string): Promise<unknown>
await mcp.shared.delete(key: string): Promise<void>

const release = await mcp.shared.lock(name: string, timeoutMs?: number): Promise<() => void>
// Always release: const release = await mcp.shared.lock('my-lock'); try { ... } finally { release(); }
```

## Environment: `env`

```typescript
const apiKey = env.MY_API_KEY;   // string | undefined
const count  = env.BATCH_SIZE;   // string | undefined (always string from env)
```

Environment variables passed to the sandbox from the Conductor config.

## Error types

```typescript
import type { MCPToolError, TimeoutError, CircuitOpenError } from '@darkiceinteractive/mcp-conductor/reliability';

try {
  const result = await mcp.callTool('server', 'tool', {});
} catch (err) {
  if (err instanceof MCPToolError) {
    console.error('Upstream error:', err.server, err.tool, err.code, err.message);
  }
}
```
