---
sidebar_position: 1
title: Architecture
---

# MCP Conductor v3 Architecture

## Overview

MCP Conductor v3 implements the production architecture described in Anthropic's
"Building Effective Agents" research — registry-driven execution with full
reliability, observability, and security layers.

```
┌─────────────────────────────────────────────────────┐
│                  Claude / LLM client                │
└───────────────────┬─────────────────────────────────┘
                    │ MCP protocol (stdio/HTTP)
┌───────────────────▼─────────────────────────────────┐
│                MCPExecutorServer                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │  Tool       │  │  Passthrough│  │  Lifecycle  │ │
│  │  Registry   │  │  Registrar  │  │  Tools (X2) │ │
│  └──────┬──────┘  └──────┬──────┘  └─────────────┘ │
│         │                │                          │
│  ┌──────▼──────────────────────────┐               │
│  │      execute_code handler       │               │
│  │  ┌──────────────────────────┐   │               │
│  │  │  Skills Engine (v3)      │   │               │
│  │  │  • mcp.callTool          │   │               │
│  │  │  • mcp.tokenize/detok    │   │               │
│  │  │  • mcp.compact/summarize │   │               │
│  │  │  • mcp.findTool          │   │               │
│  │  │  • mcp.budget            │   │               │
│  │  └──────────────────────────┘   │               │
│  └──────┬──────────────────────────┘               │
└─────────┼────────────────────────────────────────── ┘
          │
┌─────────▼─────────────────────────────────────────┐
│              ReliabilityGateway (Phase 3)          │
│  timeout → retry → circuit breaker → MCPToolError  │
└─────────┬─────────────────────────────────────────┘
          │
┌─────────▼─────────────────────────────────────────┐
│                  MCPHub                            │
│  ConnectionPool (Phase 4) + WarmSandboxPool        │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │ google-  │ │salesforce│ │  github / brave  │   │
│  │ drive    │ │          │ │  (passthrough)   │   │
│  └──────────┘ └──────────┘ └──────────────────┘   │
└────────────────────────────────────────────────────┘
          │
┌─────────▼─────────────────────────────────────────┐
│            Observability Layer (Phase 7)           │
│   CostPredictor | HotPathProfiler | AnomalyDetector│
│   ReplayRecorder (session capture/replay)          │
└────────────────────────────────────────────────────┘
```

## Components

### Tool Registry (Phase 1)

Central registry of all upstream MCP tools with metadata annotations:

- `routing`: `"execute_code"` | `"passthrough"` — how calls are routed
- `redact`: PII tokenisation matchers to apply to responses
- `examples`: sample inputs for JSDoc generation and type inference

**Key files**: `src/registry/registry.ts`, `src/registry/typegen.ts`

### Passthrough Registrar (X1)

Reads registry annotations and registers `routing: "passthrough"` tools as
first-class Conductor MCP tools. Upstream annotations are preserved.

**Key file**: `src/server/passthrough-registrar.ts`

### Skills Engine (Phase 5 expansion)

The `mcp` sandbox API available inside `execute_code`:

- `mcp.callTool(server, tool, params)` — call any upstream tool
- `mcp.tokenize(text, matchers)` — tokenise PII in a string
- `mcp.detokenize(tokenized)` — restore tokenised values
- `mcp.compact(data)` — compress data for token budget
- `mcp.summarize(data, opts)` — LLM-style summarisation
- `mcp.findTool(query)` — fuzzy search across all upstream tools
- `mcp.budget(limit)` — set token budget for the execution

### Reliability Gateway (Phase 3)

Composed reliability layer sitting between the Skills Engine and MCPHub:

```
withTimeout → withRetry → circuitBreaker
```

All upstream errors emerge as typed error classes:

- `TimeoutError` — call exceeded `timeoutMs`
- `RetryExhaustedError` — all retry attempts failed
- `CircuitOpenError` — circuit is open (fast-fail)
- `MCPToolError` — non-retryable upstream error

### Connection Pool (Phase 4)

Persistent MCP server connections with warm sandbox workers:

- `ConnectionPool`: maintains N ready connections per server
- `WarmSandboxPool`: pre-warms Deno sandbox processes

### Daemon Mode (Phase 6)

Long-running conductor process with shared KV store and distributed locks:

- `SharedKV`: process-safe key-value store
- `SharedLock`: mutex for coordinating multiple Claude instances

### Observability (Phase 7)

Three hot-path analytics modules plus session replay:

- `CostPredictor`: token cost forecasting with args-shape fingerprinting
- `HotPathProfiler`: latency p50/p95/p99 per tool
- `AnomalyDetector`: statistical outlier detection
- `ReplayRecorder`: capture + replay MCP sessions with divergence detection

### PII Tokenisation (X4)

Built-in redaction matchers applied to responses before they reach the sandbox:

- `email`, `phone`, `credit_card`, `ssn`, `ip_address`, `date_of_birth`
- Custom regex matchers via `ToolDefinition.redact.response`

### Lifecycle Tools (X2)

MCP tools for managing the Conductor itself:

- `import_servers_from_claude` — import from Claude config files
- `export_servers_to_claude` — write to Claude config
- `test_server` — transient connectivity test
- `diagnose_server` — health + reconnect status
- `recommend_routing` — apply X1 routing heuristic

## Data Flow: execute_code (execution mode)

```
1. Claude → execute_code({ code: "...", ...args })
2. MCPExecutorServer → Skills Engine
3. Skills Engine → sandbox (Deno process from WarmSandboxPool)
4. sandbox → mcp.callTool("google-drive", "getFile", ...)
5. → ReliabilityGateway.call() → MCPHub → upstream server
6. Response → PII tokenisation (X4) if redact annotations present
7. → back to sandbox (document never enters Claude context window)
8. sandbox returns compact JSON result
9. Claude sees only: { processed: 300, with_dates: 287, ... }
```

**Token reduction**: 153,900 tokens (passthrough) → 435 tokens (execution) = **99.72%**
