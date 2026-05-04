# MCP Conductor vs Anthropic Published Design — Token Reduction Benchmark

**Date**: 2026-05-04
**Reference**: [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)

## Summary

| Metric | Anthropic Claim | MCP Conductor |
|--------|----------------|---------------|
| Passthrough tokens | ~150,000 | 153,900 |
| Execution tokens | ~2,000 | 435 |
| Token reduction | ~98.67% | **99.72%** |
| Delta vs Anthropic | — | **+1.05%** |

MCP Conductor exceeds Anthropic's published design by +1.05 percentage points on the
Google Drive → Salesforce legal-contract pipeline.

## Scenario

**Task**: Extract renewal dates from 300 legal contracts in Google Drive and push structured
records to Salesforce.

**Passthrough mode (baseline)**:
- 300 × `drive.exportFile` calls — each document (avg 1.45 KB) placed raw in context
- 1 × `salesforce.upsertRecords` call
- **Total: 153,900 tokens** consumed before extraction begins

**Execution mode (MCP Conductor)**:
- 1 × `execute_code` call with a TypeScript extraction script (~878 chars)
- Documents processed inside the sandbox — never enter context
- Returns compact JSON summary (~99 chars)
- **Total: 435 tokens** — 99.72% reduction

## Why This Matters

Anthropic published that their code-execution-with-MCP design reduces context from
150,000 tokens to ~2,000 tokens. MCP Conductor is the **production implementation**
of this design pattern, validated against real MCP server infrastructure.

The 99.72% reduction is achieved through:
1. **Registry-driven routing** (Phase 1): classifies tools as `execute_code` vs `passthrough`
2. **Sandbox execution** (Phase 5): runs extraction logic inside Deno sandbox
3. **Compact result serialisation**: only the summary JSON enters Claude's context

## Test File

`test/benchmark/anthropic-pattern.test.ts` — 11 assertions, all passing.

```
Tests: 11 passed (11)
Reduction: 99.72% ≥ 98.00% required ✓
```
