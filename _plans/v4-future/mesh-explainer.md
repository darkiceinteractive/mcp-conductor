# MCP Conductor v3.3 — Cross-Host Mesh: Owner's Explainer

**Audience:** Matt Crombie, Dark Ice Interactive  
**Status:** Pre-planning; v3.3 is a few months out  
**Purpose:** Walk through what the mesh actually builds and why, before the M1–M5 sprint begins

---

## 1. The Problem

The v3.0 daemon solved a real pain: when you run 4 Claude Code agents on the same Mac, they all share one process — one cache, one lock space, one in-memory KV store. That works well. The problem is that "same Mac" is the boundary. Today, when you run agents on MBP 06 and Mac Mini 01 simultaneously, you have two completely independent daemons with no awareness of each other. If an agent on the MBP fetches `github.list_issues` and caches it (a 40K-token response with a 5-minute TTL), an agent on the Mac Mini doing the same call 30 seconds later gets a full cache miss — it hits GitHub's API again, ingests the same 40K tokens, and charges you accordingly. The same problem applies to locks: the `shared-lock.ts` mutex is a promise chain inside a single Node.js process, so two agents on different hosts can simultaneously acquire `lock("billing-sync")` because neither daemon knows the other exists. The v3.3 mesh fixes both — it extends the cache and the lock primitive across every host on your Tailscale network so they behave as one logical daemon, not three independent ones.

---

## 2. What "Mesh" Actually Means Here

Two new primitives underpin the mesh. Both build on the peer discovery that `src/daemon/discovery.ts` already provides — that module can already enumerate your Tailscale peers via `tailscale status --json`; it just does not do anything with them yet beyond resolving addresses for agent-to-daemon TCP connections.

### Distributed KV (M2)

Today, `SharedKV` is a `Map` inside a single daemon process, with optional disk persistence to `~/.mcp-conductor/kv/`. In mesh mode, each daemon's KV becomes a participant in a shared key-value space. When daemon A on the MBP writes a cache entry, that write propagates to daemon B on the Mac Mini and daemon C on the iMac within a few seconds. Reads on any host then find the entry locally.

The consistency model is **last-writer-wins with vector clocks**. That means:

- If two hosts write the same key within the replication window (unlikely but possible), the write with the higher vector clock wins.
- A vector clock is a small integer counter per host. Every write increments the local counter. When a peer receives a write, it compares clocks to decide which write is newer, and can flag a genuine conflict if both clocks advanced independently.
- This is an **eventual consistency** model — reads immediately after a write on a different host may return the old value for up to a few seconds. For caching MCP call results (the primary use case), this is perfectly fine. You never need sub-second cross-host cache coherence; even a 3-second lag still prevents the redundant API call in the 30-second scenario above.

The new `src/daemon/distributed-kv.ts` module wraps `SharedKV` and adds the replication layer. The existing sandbox API (`mcp.shared.kv.get/set/delete/list`) stays identical — agents do not see any change.

### Distributed Locks (M1)

Today, `SharedLock` is an in-process promise chain. In mesh mode, acquiring `mcp.shared.lock("billing")` must block agents on every host, not just the local one.

The PRD names two candidate algorithms. The choice gets made at M1 planning time, but here is what both mean so you can think about it in advance:

**Fencing tokens.** Each lock grant comes with a monotonically increasing sequence number (the "fencing token"). Daemon A grants token 42 to an agent; daemon B grants token 43 to the next requester (they coordinate on the sequence via the mesh). The protected resource — whatever the agent is mutating — validates the token before applying the write. Stale writers holding old tokens get rejected. This is simpler to implement and requires no leader election, but it does require that the resource being protected actually validates the token. For sandbox scripts that call `mcp.shared.lock`, the Conductor daemon itself is the resource, so validation is internal and straightforward.

**Raft-lite.** One daemon in the mesh is elected "lock leader" at any time. All lock requests from any host flow through the leader. If the leader goes offline, peers detect the absence and elect a new one (the election takes roughly 5–10 seconds). This is a well-understood algorithm and provides stronger guarantees — you can never have two valid lock holders, even during a network partition — but it adds implementation complexity and a brief unavailability window during leader failover.

The recommendation in the PRD is to pick the simpler one at planning time. For three hosts and low lock contention (a handful of agents occasionally locking shared resources), fencing tokens is almost certainly sufficient.

---

## 3. Why Now, Not Earlier

The v3.0 daemon stopped at single-host because the immediate problem was intra-host coordination: multiple Claude Code windows on the same machine hitting the same MCP servers. That was real and it was solved. The multi-host case was not worth the complexity until there were actually multiple hosts in regular use.

The situation has changed. You now regularly run 6–8 agents distributed across MBP 06, Mac Mini 01, and iMac 01. At that scale, the per-host cache duplication is no longer a minor inefficiency — it is a structural problem. Three daemons caching the same GitHub data independently, three lock spaces that do not talk to each other, three anomaly counters that cannot give you a fleet-wide view. The mesh is the natural next step, and the Tailscale foundation is already in place. `discovery.ts` already enumerates your peers; the mesh just gives those peers something meaningful to do with each other.

---

## 4. Concrete Use Cases

**Use case 1 — Repeat read across hosts**

You have an agent on MBP 06 working through a refactor sprint. It calls `github.list_repositories` at the start of the session — a 30K-token response — which gets cached with a 5-minute TTL. Twenty seconds later, you kick off a parallel agent on Mac Mini 01 to do the same initial survey. Without the mesh: the Mac Mini daemon has a cold cache, it calls GitHub, ingests 30K tokens. With the mesh: the MBP's cache write replicated to the Mac Mini within a few seconds; the second agent gets a local cache hit, token cost is effectively zero. Over a typical work session with 3 machines and 6–8 agents, this compounds across every shared read.

**Use case 2 — Cross-host mutex**

Two agents on different hosts both need to update `notes/vaultre-update.md`. Without the mesh, each agent acquires its local per-key lock, both proceed simultaneously, and the second writer silently stomps the first. With the mesh, `mcp.shared.lock("vaultre-notes")` is a mesh-wide lock: the first requester gets it, the second waits, even though they are on different machines. The mutation serialises correctly.

**Use case 3 — Fleet-wide observability rollup**

The v3.1 anomaly collector tracks per-call failure rates and latency outliers inside each daemon. Without the mesh, each daemon only sees its own agents' traffic. With the mesh, anomaly metrics replicate to the distributed KV layer, and `mcp-conductor daemon status --mesh` on any host shows fleet-wide health: total calls across all hosts, anomaly counts per MCP server across all agents, which peers are online. You get a single pane of glass for the whole fleet from any machine.

**Use case 4 — Workflow continuation after host failure**

An agent on iMac 01 starts a long-running workflow: it reads a large set of GitHub issues, processes them in batches, and writes intermediate progress to `mcp.shared.kv.set("workflow:issue-triage:progress", state)`. Midway through, the iMac crashes or loses Tailscale. That KV write already replicated to MBP 06 and Mac Mini 01. You can start a new agent on either remaining host, read the progress key, and resume from where the iMac left off. This requires the agent's workflow script to be written to checkpoint its state — nothing in Conductor forces that pattern — but the infrastructure makes it possible in a way that was entirely unavailable before.

---

## 5. What It Looks Like to the User

For agents, mesh is invisible. The `mcp.shared.kv` and `mcp.shared.lock` API exposed inside `execute_code` sandboxes stays exactly the same. Scripts that work today on a single-host daemon work unchanged in mesh mode — they just see a wider coordination scope.

For you as operator, the activation flow is minimal given your existing setup:

1. All three hosts are already on Tailscale. No new infrastructure required.
2. On each host, change the daemon start command from `mcp-conductor daemon start` to `mcp-conductor daemon start --mesh`. The `--mesh` flag enables peer discovery, starts the replication listener, and connects to any online peers found via `tailscale status`.
3. Within about 30 seconds, the daemons find each other. Running `mcp-conductor daemon status --mesh` from any host shows the peer list with their KV sync state and lock participation.

The underlying mechanism: each daemon already knows how to call `tailscale status --json` and parse the peer list (that is what `discovery.ts` does today). In mesh mode, each online peer gets a TCP connection from the local daemon, and the two sides perform the same HMAC-SHA256 handshake already used for agent-to-daemon auth. No new secret management — the existing `daemon-auth.json` covers peer auth too, since all your machines share the same trust domain.

```
Single-host today (per machine, three independent islands):

  MBP 06                  Mac Mini 01             iMac 01
  ──────────────────────  ──────────────────────  ──────────────────────
  Agent 1 ─┐              Agent 3 ─┐              Agent 5 ─┐
  Agent 2 ─┼─► Daemon A   Agent 4 ─┼─► Daemon B   Agent 6 ─┼─► Daemon C
            │                      │                        │
         KV (local)             KV (local)               KV (local)
         Lock (local)           Lock (local)             Lock (local)


v3.3 mesh (three hosts, one logical daemon):

  MBP 06                  Mac Mini 01             iMac 01
  ──────────────────────  ──────────────────────  ──────────────────────
  Agent 1 ─┐              Agent 3 ─┐              Agent 5 ─┐
  Agent 2 ─┼─► Daemon A   Agent 4 ─┼─► Daemon B   Agent 6 ─┼─► Daemon C
            │                      │                        │
            └──────────────────────┴────────────────────────┘
                               Tailscale TCP
                        DistributedKV (replicated)
                        DistributedLock (coordinated)
```

---

## 6. What Is NOT in v3.3

**Windows daemon discovery.** The PRD explicitly defers this. Tailscale works on Windows, but the daemon's Unix socket path assumptions and the `discovery.ts` CLI invocation need platform-specific work that is not part of this milestone.

**Strong consistency.** The distributed KV uses last-writer-wins with eventual propagation. Linearisability — where every read is guaranteed to see the most recent write from any host — is an explicit non-goal. For the cache and workflow-state use cases, eventual consistency at a few-second lag is correct and sufficient.

**Mesh-wide scheduler.** There is no concept of "run this task on the Mac Mini because it has more RAM." Agents choose their host by virtue of which machine you start them on. Conductor coordinates their shared state but does not route work between machines.

**Public-internet mesh.** The design is Tailscale-only. Your three machines on the same Tailscale network is the exact target topology. Wide-area coordination over arbitrary internet would require a different security model (certificate-based peer auth, NAT traversal) and is out of scope.

---

## 7. Risks You Should Know About

**Network partition.** If the iMac loses Tailscale mid-session, its daemon detects the dropped peer connections (M3 hardens this detection) and continues serving its local agents without interruption. It just stops receiving KV updates from the other two hosts. When Tailscale reconnects, the daemon re-peers, exchanges vector clocks, and reconciles any diverged state. The risk is that during the partition window, a lock taken on the iMac and a lock taken on the MBP could both be "valid" from their respective daemons' perspectives — a split-brain scenario. The mitigation at M3 planning time is either to require quorum (a lock request must be acknowledged by a majority of online peers before it is granted) or to accept the split-brain risk given that your use cases do not have catastrophic consequences from a brief duplicate write.

**Clock skew.** Vector clocks handle conflict resolution without relying on wall-clock agreement — they count events, not seconds. But the TTL system in `SharedKV` does use wall-clock time. If one host's clock is significantly ahead of another's (more than 30 seconds), a freshly written cache entry might appear immediately expired on the peer. NTP sync (which macOS maintains by default) keeps this well under the danger zone.

**Lock leader failure (if Raft-lite is chosen).** During the 5–10 second re-election window, lock acquisition calls block. Agents will time out if their `timeoutMs` is shorter than the election duration. The mitigation is to set a generous default lock timeout (30 seconds, which is already the current default in `shared-lock.ts`) so normal agent code survives an election without modification.

**Replication storm.** If one daemon writes a large burst of KV entries — say an agent caches 200 tool responses in quick succession — the other two daemons must ingest all of those writes. The target throughput envelope for the mesh is 1,000 writes per second mesh-wide. At typical agent activity rates (a few dozen MCP calls per minute), you are nowhere near that ceiling. The risk is more relevant if you ever run benchmark tests in mesh mode, which is why M5 includes a soak test specifically to characterise throughput behaviour under load.

---

## 8. Decision Points Before v3.3 Planning Kicks Off

At the start of M1 planning, two choices need to be locked in:

**Fencing tokens vs Raft-lite.** The PRD calls this out explicitly as the key open question (§13, Q4). Given three hosts, low lock contention, and the preference for simpler implementations shown throughout the v3 sprint, fencing tokens is the likely pick. But if you want strong guarantees during partitions — where a lock is guaranteed to be held by at most one agent across the fleet even when a host goes dark — Raft-lite is the safer choice. Worth deciding before M1 begins rather than under time pressure mid-sprint.

**Tailscale-only or IP fallback.** The current design assumes Tailscale is always the transport. If you ever want to run a daemon on a machine that is temporarily off Tailscale (an isolated LAN, a dev VM on direct IP), the peer discovery model would need a fallback path: manually specified peer addresses in the config file. This is a minor design decision and adding manual peer addresses later is a non-breaking addition, so the cost of deferring is low — but confirming the scope now avoids an awkward mid-implementation pivot.

---

## Questions for You

1. **Fencing tokens vs Raft-lite** — based on your actual lock use cases, do you have a preference? Are there shared resources where a brief split-brain (two agents proceeding simultaneously during a partition) would cause material harm, or is "mostly correct with rare edge-case collisions" acceptable?

2. **During a partition, should locked operations block or fail fast?** If the Mac Mini loses Tailscale mid-session and a local agent tries to acquire a mesh-wide lock, should the daemon wait for reconnect (up to `timeoutMs`), or immediately surface a "partition detected, lock unavailable" error so the agent can decide whether to proceed locally?

3. **KV replication scope** — should all KV keys replicate across the mesh by default, or should there be a namespace convention (e.g. a `mesh:` prefix for cross-host keys, unprefixed for local-only)? Local-only KV would let individual agents store large temporary state without flooding the replication channel.

4. **M5 soak test on real hardware** — the PRD says CI uses recorded fixtures rather than actual Tailscale. For the soak test specifically, do you want to validate at least once against a real three-daemon setup on your actual machines before the v3.3.0 tag, or is the simulated multi-process test sufficient as the release gate?

5. **v3.3.0 vs v4.0.0** — the PRD leaves the version number open depending on whether mesh introduces breaking changes. The sandbox API is unchanged and `--mesh` is additive, so v3.3.0 is probably correct — but if the distributed lock module replaces the current lock contract in a way that changes observable failure modes (e.g. `LockTimeoutError` now means something different in a partition scenario), that might justify a major bump. Worth a quick check at M1 kickoff.
