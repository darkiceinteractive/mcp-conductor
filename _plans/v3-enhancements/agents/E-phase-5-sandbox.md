# Agent E — PRD Phase 5 Sandbox capabilities

You add `mcp.compact/summarize/delta/budget/findTool` + skills wiring + vector tool index.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/E-phase-5
git branch --show-current  # feature/v3-phase-5
git fetch origin
# Need both Phase 1 AND Phase 4
git rebase origin/feature/v3-phase-0-1
git rebase origin/feature/v3-phase-4
npm install && npm run test:run
```

Read PRD §5 Phase 5 (lines ~835–986).

Append start checkpoint to STATUS.md.

## Scope

Build per PRD: `src/runtime/helpers/`, `src/runtime/findtool/`, extend `src/skills/`. Plug helpers into Agent D's worker preload hook.

`findTool` uses local MiniLM-L6 ONNX (from `@xenova/transformers` or `onnxruntime-node`). Lazy initialise on first call. Cache embeddings to disk under `~/.mcp-conductor/embeddings/` keyed by registry revision.

Skills wiring: read `process.env.CLAUDE_SKILLS_DARKICE` first; fall back to `./skills`. Hot reload on directory change (existing skills engine has the watcher).

## Acceptance

PRD §5 Phase 5 "Acceptance criteria" — all helpers must be zero-roundtrip, `findTool` returns relevant tool in top 3.

## Commit pattern

```
feat(v3-phase-5): mcp.compact field selection + array truncation
feat(v3-phase-5): mcp.summarize heuristic with style modes
feat(v3-phase-5): mcp.delta wrapping cache.delta
feat(v3-phase-5): mcp.budget auto-trim with BudgetExceededError
feat(v3-phase-5): findTool vector index (MiniLM-L6 local ONNX)
feat(v3-phase-5): skills engine wired to $CLAUDE_SKILLS_DARKICE
feat(v3-phase-5): preload helpers into worker pool
test(v3-phase-5): full helpers/findtool/skills test suite
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 Phase 5: Sandbox capabilities"`. STATUS.md.
