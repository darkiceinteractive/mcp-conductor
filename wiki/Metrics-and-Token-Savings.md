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
