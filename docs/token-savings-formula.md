# Token Savings Formula

MCP Conductor estimates token savings for each `execute_code` call using a two-part formula.

## Passthrough token estimate

```
passthroughTokens = (toolCalls × 150) + (dataProcessedBytes / 1024 × 256)
```

- **toolCalls**: number of backend MCP tool calls made inside the script.
- **dataProcessedBytes**: total bytes of raw data received from those calls.
- `150 tokens/call` covers per-call request/response scaffolding overhead.
- `256 tokens/KB` is an observed average for structured JSON tool payloads; actual savings vary by content density.

## Execution token estimate

```
executionTokens = ceil(codeChars / 3.5) + ceil(resultBytes / 3.8)
```

- **codeChars**: character length of the submitted code string.
- **resultBytes**: byte length of the final result JSON.
- Divisors are empirically derived from measured token/character ratios for TypeScript and JSON respectively.

## Savings

```
tokensSaved    = passthroughTokens - executionTokens
savingsPercent = tokensSaved / passthroughTokens × 100
```

## Implementation

The formula is implemented in `src/metrics/metrics-collector.ts` (`computeTokenSavings`). The `show_token_savings: true` parameter on `execute_code` attaches the computed block to the response. You can also enable it globally via `metrics.alwaysShowTokenSavings: true` in `~/.mcp-conductor.json`.

For passthrough-mode tools (tools called via `passthrough_call` or auto-registered `<server>__<tool>` shortcuts), the tokenSavings block carries a `"not applicable"` note because no code execution is involved.
