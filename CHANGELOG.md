# Changelog

All notable changes to MCP Conductor are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Token-savings reporter on execute_code (B13)** — three modes for understanding context-window savings:
  - **Mode A**: per-call `show_token_savings: boolean` flag on `execute_code` attaches a `tokenSavings` block to each response, reporting `estimatedPassthroughTokens`, `actualExecutionTokens`, `tokensSaved`, and `savingsPercent`.
  - **Mode B**: `get_metrics` response now always includes a `tokenSavings` block with `sessionActual`, `sessionEstimatedDirect`, `sessionSavingsPercent`, and a `perTool[]` breakdown.
  - **Mode C**: `metrics.alwaysShowTokenSavings: boolean` in `~/.mcp-conductor.json` (default `false`) — when `true`, every `execute_code` call returns the savings block without the per-call flag.
  - `computeTokenSavings(input: TokenSavingsInput): TokenSavings` exported as a standalone pure function from `src/metrics/index.ts`.
  - New constants exported: `TOOL_CALL_OVERHEAD_TOKENS` (150), `TOKENS_PER_KB` (256), `CODE_CHARS_PER_TOKEN` (3.5), `JSON_CHARS_PER_TOKEN` (3.8).
  - `MetricsCollector.recordToolCall(server, tool, responseBytes, isPassthrough)` for per-tool aggregation.
  - `MetricsCollector.getTokenSavings(): SessionTokenSavings` for session-level reporting.
  - Wiki: `Metrics-and-Token-Savings.md` updated with reporter documentation, all three modes, example output, and full caveats section.
