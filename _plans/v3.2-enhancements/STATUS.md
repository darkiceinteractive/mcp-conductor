# v3.2 Milestone — Status

**Branch**: `feature/v3.2` (off `feature/v3.1` @ e6c8b5d)
**PRD**: `_plans/v3-future/MCP-Conductor-v3.1-v3.2-v3.3-PRD.md` §8
**Started**: 2026-05-05
**Target tag**: `v3.2.0-rc.1` → `@next` → 7-day soak → `@latest`

## Block ledger

| ID | Title | Status | Owner | PR |
|---|---|---|---|---|
| C1 | Typegen annotation passthrough (proper H4 fix; replaces v3.1 name-pattern heuristic) | pending | — | — |
| C2 | Pluggable PII matchers — inline regex form | pending | — | — |
| C3 | Pluggable PII matchers — function-form (Deno worker, no fs/net) | pending | — | — |
| C4 | ONNX-backed `findTool` upgrade *(conditional on v3.1 nightly metrics)* | pending | — | — |
| C5 | Skills directory sandbox API: `skills.run/list/findByQuery` | pending | — | — |
| D8 | Docs site pages for C1/C2/C3/C4/C5 + v3.2 selector entry | pending | — | — |
| D9 | Article 2 source: `articles/v3-hardening/article.md` (~1500 words) | pending | — | — |
| R2 | Release v3.2.0-rc.1 (tag → npm `@next`) | pending | — | — |

## Conditional gating

- **C4 (ONNX `findTool`)** only proceeds if v3.1 nightly metrics show TF-IDF top-3 hit rate < 80%. The first 7 nightly runs after v3.1 hits `@latest` are the input. If skipped, mark C4 `deleted` and update PRD §8.

## Wave plan

- **Wave 1** (independent, can parallel):
  - C1 — typegen annotation passthrough
  - C2 — inline-regex PII matchers
  - C5 — skills sandbox API
  - D8 starts after any of C1/C2/C5 lands (incremental docs)
- **Wave 2** (after Wave 1):
  - C3 — function-form PII matchers (depends on C2)
  - C4 — ONNX findTool (conditional)
  - D9 — Article 2 (depends on C1+C2 narrative content)
- **Wave 3**:
  - R2 — release cut

## Done criteria (PRD §12)

- All C blocks + D8 + D9 merged
- Nightly clean for 3 consecutive runs
- Article 2 published as Medium draft
- `v3.2.0-rc.1` tagged + on `@next`
- 7-day soak → promote to `@latest`

## Pre-flight gates

- [ ] PR #28 merged to main (v3.1 → main)
- [ ] v3.1.0-rc.1 published to npm `@next`
- [ ] Nightly real-API workflow has at least 3 green runs (validates v3.1 baseline)
- [ ] User has added secrets for popular-MCP nightly (see `docs/dev/nightly-walkthrough.md`)

## Notes

- Mesh (former v3.3) deferred to v4.0; do NOT scope mesh into v3.2.
- Worktree pattern: per-block worktree at `mcp-executor-darkice-worktrees/{C1,C2,...}/`.
- GateGuard: every Edit/Write/Bash needs a 4-fact preamble. Sub-agents use bash-heredoc bootstraps.
