# Metrics & Token Savings

MCP Conductor tracks detailed metrics for every execution, including token savings estimates that quantify the benefit of using the sandbox over direct passthrough calls.

## Token Estimation Formula

The formula is implemented in `src/metrics/metrics-collector.ts` and used consistently across production code and benchmarks.

### Passthrough Mode Tokens

When tool calls go directly to Claude's context window (passthrough mode):

```
passthroughTokens = (toolCalls × 150) + (dataBytes / 1024 × 256)
```

| Constant | Value | Meaning |
|----------|-------|---------|
| `TOOL_CALL_OVERHEAD_TOKENS` | 150 | Request/response envelope per call |
| `TOKENS_PER_KB` | 256 | Token cost of raw data (~4 bytes/token) |

### Execution Mode Tokens

When code runs in the sandbox and only the compact result enters context:

```
executionTokens = ceil(codeChars / 3.5) + ceil(resultJson.length / 3.8)
```

| Constant | Value | Meaning |
|----------|-------|---------|
| `CODE_CHARS_PER_TOKEN` | 3.5 | TypeScript is denser than prose |
| `JSON_CHARS_PER_TOKEN` | 3.8 | JSON structural overhead (keys, quotes) |

### Compression Percentage

```
compressionPct = (passthroughTokens − executionTokens) / passthroughTokens × 100
```

Typical results: **88% (small)** → **95% (medium)** → **99% (large)** → **99.4% (enterprise)**.

## Per-Execution Metrics

Every `execute_code` call records:

| Field | Type | Description |
|-------|------|-------------|
| `executionId` | string | Unique execution identifier |
| `timestamp` | Date | When the execution started |
| `durationMs` | number | Wall-clock execution time |
| `success` | boolean | Whether the execution succeeded |
| `codeTokens` | number | Estimated tokens for the code sent |
| `resultTokens` | number | Estimated tokens for the result returned |
| `toolCalls` | number | Number of MCP tool calls made |
| `dataProcessedBytes` | number | Total bytes processed from servers |
| `resultSizeBytes` | number | Size of the returned result |
| `estimatedTokensSaved` | number | Passthrough tokens minus execution tokens |
| `savingsPercent` | number | Compression percentage |
| `mode` | string | `execution` or `passthrough` |
| `serversUsed` | string[] | Which MCP servers were called |
| `toolsUsed` | string[] | Which tools were invoked |

## Session Metrics

Aggregated across all executions in a session:

| Category | Fields |
|----------|--------|
| Execution counts | `totalExecutions`, `successfulExecutions`, `failedExecutions` |
| Tool usage | `totalToolCalls`, `toolCallsByServer`, `toolCallsByTool` |
| Data | `totalDataProcessedBytes`, `totalResultBytes`, `averageDataPerExecution` |
| Token savings | `totalTokensSaved`, `averageTokensSaved`, `averageSavingsPercent` |
| Performance | `averageDurationMs`, `minDurationMs`, `maxDurationMs` |
| Mode breakdown | `executionModeCount`, `passthroughModeCount` |
| Errors | `totalErrors`, `errorsByType` |

## Using `get_metrics`

Call the `get_metrics` tool (no parameters) to retrieve session statistics:

```json
{
  "totalExecutions": 47,
  "averageCompressionRatio": 0.943,
  "totalTokensSaved": 1847230,
  "averageExecutionMs": 73,
  "lastExecution": {
    "compressionRatio": 0.978,
    "tokensSaved": 44200,
    "inputTokens": 45000,
    "outputTokens": 800
  }
}
```

## Windowed Metrics

The metrics collector supports time-windowed analysis for trend detection:

- Recent window (last N executions) for moving averages
- Time-based windows for throughput calculations
- Error rate tracking by time period

## Metrics Persistence

Metrics can be persisted to disk for cross-session analysis:

```json
{
  "metrics": {
    "enabled": true,
    "persistPath": "~/.mcp-conductor/metrics/"
  }
}
```

Files are written as JSON Lines (`.jsonl`) for efficient append-only logging.

## Benchmark Suite

Run the benchmark suite to validate token savings with realistic fixture data:

```bash
# Scale benchmarks (4 scales × 3 scenarios)
npm run benchmark:scale

# Full benchmark suite with Vitest assertions
npm run test:benchmark
```

Results are written to `docs/benchmarks/results-YYYY-MM-DD.{md,json}`.

See [Benchmark Methodology](./Benchmark-Methodology) for full details on fixture construction and validation.

---

## Token-Savings Reporter (B13)

As of v3.1, MCP Conductor includes a built-in token-savings reporter that estimates how many context-window tokens `execute_code` saved versus calling the same tools in passthrough mode. There are three ways to use it.

### Mode A — Per-call inline report

Add `show_token_savings: true` to any `execute_code` call:

```typescript
// In Claude
const result = await mcp.execute_code({
  code: `
    const files = await mcp.filesystem.call('list_directory', { path: '/src' });
    return files;
  `,
  show_token_savings: true,
});
```

The response gains a `tokenSavings` block:

```json
{
  "success": true,
  "result": { "files": ["index.ts", "config.ts"] },
  "tokenSavings": {
    "estimatedPassthroughTokens": 3250,
    "actualExecutionTokens": 87,
    "tokensSaved": 3163,
    "savingsPercent": 97.3
  }
}
```

For passthrough-mode tools (no data returned to context), the block carries a note:

```json
{
  "tokenSavings": {
    "estimatedPassthroughTokens": 0,
    "actualExecutionTokens": 15,
    "tokensSaved": 0,
    "savingsPercent": 0,
    "note": "This tool is passthrough — execute_code routing not applicable."
  }
}
```

### Mode B — Session aggregate via get_metrics

Call `get_metrics` to see savings across the entire session:

```json
{
  "tokenSavings": {
    "sessionActual": 1240,
    "sessionEstimatedDirect": 187500,
    "sessionSavingsPercent": 99.3,
    "perTool": [
      {
        "server": "google-drive",
        "tool": "export_file",
        "calls": 300,
        "actualTokens": 0,
        "estimatedPassthroughTokens": 153450,
        "savingsPercent": 100
      },
      {
        "server": "salesforce",
        "tool": "upsert_records",
        "calls": 1,
        "actualTokens": 0,
        "estimatedPassthroughTokens": 150,
        "savingsPercent": 100
      }
    ]
  }
}
```

### Mode C — Global config default

Set `metrics.alwaysShowTokenSavings: true` in `~/.mcp-conductor.json` to attach the savings block to every `execute_code` response automatically, without using the per-call flag:

```json
{
  "metrics": {
    "alwaysShowTokenSavings": true
  }
}
```

### Caveats

The savings estimate is a **model, not a measurement**. Keep these in mind:

- **256 tokens/KB is an observed average.** The actual Claude tokeniser output varies by content type. Dense binary-encoded data compresses more; natural language compresses less.
- **Per-call overhead (150 tokens) dominates for tiny responses.** When a tool returns only a few bytes, the 150-token request/response envelope means savings may be near zero or slightly negative before clamping. This is correct behaviour — the overhead-dominated case is where passthrough is competitive.
- **For passthrough-mode tools, savings always show zero.** These tools never place data in the Claude context window in either mode, so the comparison is not applicable. The `note` field signals this explicitly.
- **For mutation tools (write, upsert, delete), the savings number is informational only.** The data being written is not returned to context in either mode, so the figure reflects the response payload only.

### Formula reference

```
passthroughTokens = (toolCalls × 150) + (dataProcessedBytes / 1024 × 256)
executionTokens   = ceil(codeChars / 3.5) + ceil(resultBytes / 3.8)
tokensSaved       = max(0, passthroughTokens - executionTokens)
savingsPercent    = round(tokensSaved / passthroughTokens × 100, 1 decimal)
```

The formula is implemented in `src/metrics/metrics-collector.ts` as the exported `computeTokenSavings()` pure function, which can be called independently of any `MetricsCollector` instance.
