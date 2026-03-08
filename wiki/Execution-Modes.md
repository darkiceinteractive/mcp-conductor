# Execution Modes

MCP Conductor supports three operating modes that control how Claude's requests are handled.

## Mode Overview

| Mode | Description | Token Impact |
|------|-------------|-------------|
| `execution` | All requests routed through Deno sandbox (default) | Minimum tokens |
| `passthrough` | Direct tool calls forwarded without sandbox | Maximum tokens |
| `hybrid` | Automatic selection based on task complexity | Variable |

## Execution Mode (Default)

In execution mode, all MCP operations go through `execute_code`. Claude writes TypeScript that runs in the Deno sandbox, and only the compact return value enters the context window.

This is the recommended mode for maximum token savings (88-99% reduction).

```
Claude -> execute_code("...TypeScript...") -> Deno sandbox -> compact result
```

## Passthrough Mode

In passthrough mode, tool calls are forwarded directly to backend servers. The raw server response enters Claude's context window with no filtering.

Useful for:
- Debugging individual tool calls
- Verifying server responses
- When you need raw data in context

```
Claude -> passthrough_call("github", "get_repo", {...}) -> raw JSON in context
```

## Hybrid Mode

Hybrid mode automatically selects execution or passthrough based on task complexity heuristics:

- **Simple tasks** (single tool call, small expected response) -> passthrough
- **Complex tasks** (multiple calls, large data, aggregation needed) -> execution

The decision logic considers:
- Number of expected tool calls
- Estimated response size
- Whether aggregation/filtering is needed
- Whether multiple servers are involved

## Switching Modes

### At Runtime

Ask Claude to call `set_mode`:

```json
{ "mode": "passthrough" }
```

Response:
```json
{
  "previousMode": "execution",
  "currentMode": "passthrough",
  "message": "Mode changed successfully"
}
```

### Via Configuration

In `~/.mcp-conductor.json` or environment:

```json
{ "execution": { "mode": "execution" } }
```

```bash
export MCP_EXECUTOR_MODE=hybrid
```

### Comparing Modes

Use `compare_modes` to see how a task would run in each mode:

```json
{ "task": "List all TypeScript files and count lines in each" }
```

Returns estimated calls and token usage for both modes, with a recommendation.

## Exclusive vs Non-Exclusive

Orthogonal to execution mode, the `exclusive` flag in `~/.mcp-conductor.json` controls server visibility:

- **`exclusive: true`** — Claude sees only `mcp-conductor` tools. Backend servers are sandbox-only. Enforces the execution pattern.
- **`exclusive: false`** — Claude sees both `mcp-conductor` and all backend server tools. Can choose either pattern.

**Recommendation:** Use `exclusive: true` with `execution` mode for maximum token savings.
