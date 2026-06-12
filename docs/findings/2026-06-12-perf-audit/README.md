# Performance + Token Optimisation Audit — 2026-06-12 (AEDT)

This folder contains findings from a comprehensive performance and token-optimisation
audit of the `mcp-conductor` project, specifically the `feat/lean-defaults` branch,
captured on 2026-06-12 (AEDT).

## Purpose

Specialist agents each analysed one dimension of the system and wrote a numbered
finding document. A final synthesis document ranks findings by impact and proposes
a remediation order.

## How to read

Start with `00-baseline.md` (system state at audit time), then read findings
`01–15` in any order. `SYNTHESIS.md` cross-references all findings, ranks by
severity, and recommends action priorities.

## Planned files

| File | Title | Status |
|------|-------|--------|
| `00-baseline.md` | System state, probe results, git log | Written |
| `01-startup-latency.md` | Hub init blocking: 10 s cold-start | Pending |
| `02-failed-server-impact.md` | 3/22 hard failures + retry storm | Pending |
| `03-tools-count-vs-schema.md` | 29 meta-tools vs 498-tool catalog inflation | Pending |
| `04-instructions-token-cost.md` | 3 086-char instructions on every initialize | Pending |
| `05-catalog-layer.md` | catalog.ts presence layer — correctness + scope | Pending |
| `06-max-result-tokens-guard.md` | Default guard + terse narration (dd35f7a) | Pending |
| `07-diag-mode.md` | set_diag_mode per-call telemetry overhead | Pending |
| `08-passthrough-registrar.md` | passthrough-registrar.ts growth (352 lines) | Pending |
| `09-mcp-server-complexity.md` | mcp-server.ts at 2 992 lines — complexity risk | Pending |
| `10-bridge-ceiling.md` | Bridge throughput ceiling at 155 RPS | Pending |
| `11-large-payload-tokenize.md` | tokenizeMs 2 036 ms at 10 MB | Pending |
| `12-findtool-scaling.md` | findTool p99 359 ms at 10 000-tool index | Pending |
| `13-slow-backend-cascade.md` | Gateway timeout behaviour under slow backends | Pending |
| `14-concurrency-throughput.md` | execute_code concurrency: 1 650 calls/s @ 100 | Pending |
| `15-daemon-mode.md` | Daemon-mode multi-agent benchmark reference | Pending |
| `SYNTHESIS.md` | Ranked findings + remediation roadmap | Pending |

## Audit environment

- Branch: `feat/lean-defaults`
- Commit: `f12f5f5e219e99c5cd7552cebceabd18b4bcd17b`
- Node: v26.0.0 / darwin
- Probe date: 2026-06-12T08:20:xx UTC
- Conducted by: automated measurement agents; no production traffic modified
