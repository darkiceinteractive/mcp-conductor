# MCP Conductor v3 — Multi-Agent Handoff

**Status**: ready to spawn agents
**Baseline**: `feature/v3` HEAD (commit `8e6d1ad` — X3 partial cleanup, mcp.batch dual sig + concurrency 5→8)
**Authoritative PRD**: `MCP-Conductor-v3-PRD.md`
**Authoritative consolidated plan**: `/Users/mattcrombie/.claude/plans/read-this-analysis-from-rosy-whale.md`

---

## How this works

10 agent prompts live under `agents/`. Each is self-contained — paste it as the first message into a fresh Claude Code session running in the corresponding git worktree. Run **4–6 in parallel**.

Dependencies (only Agent A unblocks the rest):

```
                 A (PRD Phase 0 + Phase 1 + finish X3)
                              │
   ┌────────┬─────────┬───────┼─────────┬─────────┬─────────┐
   ▼        ▼         ▼       ▼         ▼         ▼         ▼
   B        C         D       E         F         G         H, I, J
 cache  reliability pools  sandbox  daemon   observ.   X1/X2/X4
 (P2)    (P3)      (P4)    (P5)*    (P6)     (P7)
                          *also needs D (Phase 4)
```

When Agent A pushes `feature/v3-phase-0-1`, every other agent runs `git fetch && git rebase origin/feature/v3-phase-0-1` in their worktree before starting.

After all 10 ship their PRs to `feature/v3`, **Agent K (integration)** runs in a fresh CC session — it merges everything, runs the head-to-head benchmark vs Anthropic's 150K→2K example, soak-tests, completes docs, and tags `v3.0.0-beta.1`.

---

## Worktree setup (run this once before spawning anything)

```bash
cd /Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice
bash _plans/v3-enhancements/setup-worktrees.sh
```

That creates 10 worktrees under `/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice-worktrees/`, one per agent, each on its own branch off `feature/v3`. Cleanup at the end is one `cleanup-worktrees.sh` call.

---

## Spawning an agent (template)

For any agent N (A, B, C, …):

```bash
cd /Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice-worktrees/<N-...>/
claude   # start a fresh CC session
# Then paste the contents of _plans/v3-enhancements/agents/<N-...>.md as the first message
```

Each agent has clear scope, file paths, acceptance criteria, commit message convention, and a "when to stop" instruction. They write a checkpoint to `_plans/v3-enhancements/STATUS.md` at start and at end (and any blocker mid-stream).

---

## Recommended spawn order (4–6 in parallel)

**Day 1, morning**: spawn Agent A only.

**Day 1, afternoon (after A pushes Phase 0+1)**: spawn 4 in parallel: B, C, D, G.

**Day 2, morning (after D pushes Phase 4)**: spawn E, F.

**Day 2, afternoon (after A pushes Phase 1, can be earlier)**: spawn H, I, J in parallel.

**Day 3 (after all PRs merged to `feature/v3`)**: spawn Agent K (integration) in a fresh CC session at the main repo path.

---

## Coordination protocol

### Communication: STATUS.md

Single shared file (`_plans/v3-enhancements/STATUS.md`). Every agent appends a section under their letter at:
- **start** of work (one line: branch, started timestamp)
- **each acceptance criterion met** (one line, checkmark)
- **completion** (final block: tests/coverage stats, PR URL, commit SHA)
- **blockers** if any (line starting `BLOCKED:` with what's needed)

Why one file: easy to poll, single source of truth, conflicts on append are rare. If two agents race the file, the second to push rebases the trivial conflict — both updates merge cleanly because each agent owns its own section header.

### Branching

- Each agent works on its dedicated worktree branch (`feature/v3-phase-N` or `feature/v3-x-N`).
- When done, agent opens a PR back to `feature/v3` (NOT to `main`).
- Agent K (integration) merges all PRs in dependency order at the end.

### Commits within an agent

- Conventional commit format: `<scope>(v3-phase-N): <subject>` e.g. `feat(v3-phase-1): typed ToolRegistry with .d.ts gen`.
- Multiple commits per phase are fine; each commit should pass tests and lint individually.
- Final commit on the branch should be a `chore(v3-phase-N): final` no-op-style "ready for PR" marker if the agent wants a clean PR title — optional.

### Tests

- Every commit: `npm run test:run` clean.
- Every commit: `npm run lint` clean.
- Every commit: `npm run build` clean.
- Coverage threshold: must not drop below 82%.

### Conflicts

If an agent finds their files were touched by Agent A's foundation, they `git rebase origin/feature/v3-phase-0-1` and resolve. If conflict is non-trivial, they leave a `BLOCKED: rebase conflict in <file>` line in STATUS.md and stop.

### Hand-off marker

When an agent's PR is open and CI is green, the agent updates STATUS.md with `READY-FOR-MERGE: <PR URL>` under its section. Agent K reads this list at integration time.

---

## Files in this bundle

| File | Purpose |
|---|---|
| `MCP-Conductor-v3-PRD.md` | Full PRD (1432 lines) — every agent reads the relevant section |
| `README.md` (this file) | Handoff index + coordination protocol |
| `STATUS.md` | Shared status file — every agent appends here |
| `setup-worktrees.sh` | Creates the 10 worktrees |
| `cleanup-worktrees.sh` | Removes them after merge |
| `agents/A-phase-0-1-and-x3.md` | Agent A: Phase 0 + Phase 1 + finish X3 leftovers |
| `agents/B-phase-2-cache.md` | Agent B: PRD Phase 2 |
| `agents/C-phase-3-reliability.md` | Agent C: PRD Phase 3 + MCPToolError class |
| `agents/D-phase-4-pools.md` | Agent D: PRD Phase 4 |
| `agents/E-phase-5-sandbox.md` | Agent E: PRD Phase 5 |
| `agents/F-phase-6-daemon.md` | Agent F: PRD Phase 6 |
| `agents/G-phase-7-observability.md` | Agent G: PRD Phase 7 |
| `agents/H-x1-passthrough.md` | Agent H: Workstream X1 (passthrough adapter) |
| `agents/I-x2-lifecycle-cli.md` | Agent I: Workstream X2 (lifecycle tools + CLI wizard) |
| `agents/J-x4-tokenization.md` | Agent J: Workstream X4 (PII tokenization) |
| `agents/K-integration.md` | Agent K: integration day (benchmarks, soak, beta tag) |

---

## Decisions baked in (do not relitigate inside an agent)

- Default routing for new servers in X1: `execute_code` (current behaviour, opt-in passthrough per tool).
- Import scope X2: one-way client → Conductor, confirm-prompt to remove originals after writing `.bak`.
- CLI X2: full interactive wizard (`@inquirer/prompts`) plus flag-driven non-interactive forms.
- PII tokenization X4: built-in matchers only (email/phone/SSN/credit-card/IBAN/IP); inline-regex deferred.
- Tag scheme: `v3.0.0-beta.1` straight to `@next` once all X workstreams + PRD phases land.
- X1 ships with default routing recommendations for `github`/`filesystem`/`brave-search`; user-overridable.
- `feature/v3` branched from `refactor/2.0-alpha` (not `main`) to preserve alpha.1 baseline.
- Daemon auth: shared secret file (mode 0600); no OS keychain in v3.
- `findTool` embedding model: local MiniLM-L6 ONNX first; remote fallback in v3.1.
- Cross-daemon Tailscale mesh: deferred to v3.1.
