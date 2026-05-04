# Changelog

All notable changes to MCP Conductor are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **D2 — v3 docs migrated into Docusaurus** at `docs.darkice.co` (build green; sidebar configured for Architecture, Configuration, Sandbox API, Recipes, Migration).
- **D5 — CHANGELOG backfilled** to v1.0.0 in Keep a Changelog format.
- **D6 — README v3.1 refresh** with v3 stats, docs site link, token-savings reporter quick example.
- **Token-savings reporter on execute_code (B13)** — three modes for understanding context-window savings:
  - **Mode A**: per-call `show_token_savings: boolean` flag on `execute_code` attaches a `tokenSavings` block to each response, reporting `estimatedPassthroughTokens`, `actualExecutionTokens`, `tokensSaved`, and `savingsPercent`.
  - **Mode B**: `get_metrics` response now always includes a `tokenSavings` block with `sessionActual`, `sessionEstimatedDirect`, `sessionSavingsPercent`, and a `perTool[]` breakdown.
  - **Mode C**: `metrics.alwaysShowTokenSavings: boolean` in `~/.mcp-conductor.json` (default `false`) — when `true`, every `execute_code` call returns the savings block without the per-call flag.
  - `computeTokenSavings(input: TokenSavingsInput): TokenSavings` exported as a standalone pure function from `src/metrics/index.ts`.
  - New constants exported: `TOOL_CALL_OVERHEAD_TOKENS` (150), `TOKENS_PER_KB` (256), `CODE_CHARS_PER_TOKEN` (3.5), `JSON_CHARS_PER_TOKEN` (3.8).
  - `MetricsCollector.recordToolCall(server, tool, responseBytes, isPassthrough)` for per-tool aggregation.
  - `MetricsCollector.getTokenSavings(): SessionTokenSavings` for session-level reporting.
  - Wiki: `Metrics-and-Token-Savings.md` updated with reporter documentation, all three modes, example output, and full caveats section.
- **Docusaurus docs site scaffold (D1)** — first build green, content migration in D2.
- **Daemon hardening cluster (B2 + B3 + B4 + B5)**:
  - B2: 10MB receive buffer cap on daemon socket; oversized streams destroyed.
  - B3: CBOR disk cache validates entries post-decode; malformed files discarded with warning.
  - B4: `sharedSecretPath` validated to resolve within `~/.mcp-conductor`.
  - B5: `import_servers_from_claude` summary scrubs env values and inline tokens.

---

## [3.0.0-beta.2] - 2026-05-04

### Added

- All v3 sprint features merged from feature/v3 (PR #12): Tool Registry & Type Generation, Cache Layer, Reliability Gateway, Connection + Worker Pool, Sandbox Capabilities, Daemon Mode, Observability + Replay, Passthrough Adapter, Lifecycle MCP Tools + CLI Wizard, PII Tokenization.
- Anthropic 150K → 2K head-to-head benchmark — 99.72% reduction.

### Fixed

- Critical/high findings from PR #12 review (BETA daemon hardening, GAMMA MCPToolError serialization + PII scrub, ALPHA cache + reliability wiring + test_server + passthrough + import dryRun).

### Changed

- `engines.node` bumped from `>=18.0.0` to `>=20.0.0` (Node 18 EOL April 2025).
- CI matrix dropped Node 18 (`[20.x, 22.x]` only).

## [3.0.0-beta.1] - 2026-05-04

### Added

- v3 sprint deliverables (held due to critical bugs surfaced in review; superseded by v3.0.0-beta.2).

## [2.0.0-alpha.1] - 2026-04-26

### Added

- Phase 1 alpha cut: MCP SDK upgrade (1.0.0 → 1.29.0), tool annotations on all 14 tools, Origin/Host DNS-rebinding guard, Mcp-Session-Id header handling, MCP progress + cancellation for execute_code, secret redaction in logs + orphan process detection.

## [1.1.0] - 2026-04-22

### Added

- Initial public release with PR #1 (memory-leak fix, shutdown chain, Deno process tracking, ESLint 9 flat config, CI flake fixes).

## [1.0.0] - 2026-03-08

### Added

- Initial CLI release of @darkiceinteractive/mcp-conductor.
