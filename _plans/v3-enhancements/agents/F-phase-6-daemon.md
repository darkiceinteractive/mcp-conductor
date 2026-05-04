# Agent F — PRD Phase 6 Daemon mode + multi-agent coordination

You promote Conductor to a Tailscale-discoverable daemon shared by multiple Claude Code agents.

## Setup

```bash
pwd  # /mcp-executor-darkice-worktrees/F-phase-6
git branch --show-current  # feature/v3-phase-6
git fetch origin && git rebase origin/feature/v3-phase-0-1
npm install && npm run test:run
```

Read PRD §5 Phase 6 (lines ~988–1122).

Append start checkpoint to STATUS.md.

## Scope

Build `src/daemon/{server,client,discovery,shared-kv,shared-lock}.ts` and CLI subcommands `src/cli/daemon.ts` (the latter integrates with Agent I's CLI scaffold — design the daemon CLI as a self-contained module Agent I imports).

Auth: shared secret file (mode 0600) at `~/.mcp-conductor/daemon-auth.json`. NO OS keychain in v3.

Locks: in-process mutex per key. Cross-daemon Tailscale mesh deferred to v3.1 (PRD §3).

KV: in-memory + disk-persistent under `~/.mcp-conductor/kv/`. TTL supported.

Sandbox API: `mcp.shared.{kv,lock,broadcast,subscribe}` — wire into worker preload (coordinate with Agent D's hook).

## Acceptance

PRD §5 Phase 6 "Acceptance criteria".

## Commit pattern

```
feat(v3-phase-6): DaemonServer with Unix socket + optional TCP
feat(v3-phase-6): DaemonClient stdio bridge for transparent agent connection
feat(v3-phase-6): shared KV with TTL + disk persistence
feat(v3-phase-6): shared lock primitive (in-process mutex)
feat(v3-phase-6): broadcast/subscribe (in-process pub/sub)
feat(v3-phase-6): Tailscale peer discovery
feat(v3-phase-6): daemon CLI subcommands (start/stop/status/logs)
feat(v3-phase-6): mcp.shared.* sandbox API
test(v3-phase-6): daemon + KV + lock test suites + two-agent integration
```

## PR + stop

`gh pr create --base feature/v3 --title "v3 Phase 6: Daemon mode + multi-agent coordination"`. STATUS.md.
