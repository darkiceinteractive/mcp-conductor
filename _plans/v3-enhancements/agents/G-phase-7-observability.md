# Agent G — PRD Phase 7 Observability + replay

You add cost prediction, hot-path profiling, anomaly detection, and deterministic replay.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/G-phase-7
git branch --show-current  # feature/v3-phase-7
git fetch origin && git rebase origin/feature/v3-phase-0-1
npm install && npm run test:run
```

Read PRD §5 Phase 7 (lines ~1124–1226).

Append start checkpoint to STATUS.md.

## Scope

Build `src/observability/{cost-predictor,hot-path,anomaly,replay}.ts` and `src/cli/replay.ts`. New MCP tools: `predict_cost`, `get_hot_paths`, `record_session`, `stop_recording`, `replay_session`.

Hook into the bridge call path — instrument once at the gateway, no per-call burden.

Replay journal as `.jsonl` under `~/.mcp-conductor/recordings/`. Rotate at 1GB total.

## Acceptance

PRD §5 Phase 7 "Acceptance criteria" — cost predictor within 30%, replay reproduces bit-identical without modifications.

## Commit pattern

```
feat(v3-phase-7): cost predictor with args-shape fingerprint
feat(v3-phase-7): hot-path profiler with rolling window
feat(v3-phase-7): anomaly detector (3σ outlier)
feat(v3-phase-7): replay record + replay with divergence detection
feat(v3-phase-7): five new MCP tools registered
feat(v3-phase-7): replay CLI subcommand
test(v3-phase-7): full observability + replay test suite
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 Phase 7: Observability + replay"`. STATUS.md.
