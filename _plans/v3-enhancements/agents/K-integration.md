# Agent K — Integration day

You're the final agent. All 10 prior PRs are merged to `feature/v3` (or about to be). You run benchmarks, soak test, finish docs, and tag `v3.0.0-beta.1`.

## Setup

You run at the **main repo path** (no worktree). The other worktrees may still exist; that's fine — they'll be cleaned up after.

```bash
cd /Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice
git checkout feature/v3
git pull
git log --oneline -30   # confirm all 10 PRs are in
npm install && npm run build && npm run test:run && npm run lint
```

Read STATUS.md to see what each agent reported. Confirm all 10 sections show `READY-FOR-MERGE` or `completed`.

Append start checkpoint to STATUS.md under Agent K.

## Scope

### Block 1 — Merge any open PRs in dependency order

```
A → (B, C, D, G, H) parallel → (E, F) → (I after F, J after H)
```

Use `gh pr merge --squash --auto` if CI is green. If conflicts: rebase the lagging branch on `feature/v3` and re-push.

### Block 2 — Head-to-head benchmark vs Anthropic 150K → 2K

Implement the Google-Drive-to-Salesforce style chain as a benchmark fixture:
- New file: `test/benchmark/anthropic-pattern.test.ts`
- New fixture: `test/fixtures/google-drive-to-salesforce.ts` (synthetic 150K-token document chain → record extraction → Salesforce update)
- Assert ≥ 98% reduction (matches Anthropic's claim)
- Output: `docs/benchmarks/anthropic-comparison-YYYY-MM-DD.{json,md}`

This backs the positioning claim "the production implementation of Anthropic's published design."

### Block 3 — One-hour soak test against fault-injected backends

Use Phase 7's replay infrastructure. Synthetic faults: 10% timeout, 5% 500-error, 1% truncated response. Assert 0 hangs, all errors surfaced as `MCPToolError`.

### Block 4 — Complete docs

Per PRD §6.4:
- `docs/v3/architecture.md` — diagrams + component overview
- `docs/v3/migration.md` — v2 → v3 migration
- `docs/v3/configuration.md` — full config reference (registry/cache/reliability/runtime/skills/findTool/daemon/observability sections)
- `docs/v3/sandbox-api.md` — updated `mcp` API (helpers, skills, shared, tokenize, fs)
- `docs/v3/recipes.md` — example execute_code workflows showcasing v3 features
- Update top-level `README.md` with v3 highlights

### Block 5 — Tag v3.0.0-beta.1

```bash
# Bump package.json to 3.0.0-beta.1
# (publish.yml routes "*-beta*" to @next via the existing *-* fallback)
git commit -am "chore: prep v3.0.0-beta.1"
git tag -a v3.0.0-beta.1 -m "v3.0.0-beta.1 — registry-driven architecture, full sprint complete"
git push origin feature/v3
git push origin v3.0.0-beta.1
```

CI publishes to `@next`. Verify with `npm view @darkiceinteractive/mcp-conductor@next`.

### Block 6 — Open PR feature/v3 → main

```bash
gh pr create --base main --title "v3.0.0-beta.1: registry-driven Conductor (PRD Phases 1-7 + X1/X2/X4)" --body "..."
```

Don't merge — leave it open for human review.

### Block 7 — Cleanup

```bash
bash _plans/v3-enhancements/cleanup-worktrees.sh
git branch -D feature/v3-phase-{0-1,2,3,4,5,6,7} feature/v3-x{1-passthrough,2-lifecycle,4-tokenization}
```

Update STATUS.md final block: "v3.0.0-beta.1 published to @next; PR to main open at <URL>; worktrees cleaned."

## When to stop

After the PR to `main` is open and STATUS.md is updated. Do NOT merge to main — that's @matt's call after review.
