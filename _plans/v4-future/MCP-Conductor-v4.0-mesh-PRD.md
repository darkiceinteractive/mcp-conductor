# MCP Conductor v4.0 — Cross-Host Mesh PRD

**Status:** Deferred from v3.3 → v4.0 (owner decision, 2026-05-04). Awaiting kickoff.
**Owner:** Matt Crombie / Dark Ice Interactive
**Predecessor PRDs:** `_plans/v3-enhancements/MCP-Conductor-v3-PRD.md` (v3 architecture), `_plans/v3-future/MCP-Conductor-v3.1-v3.2-v3.3-PRD.md` (originally housed mesh as §9)
**Companion document:** `mesh-explainer.md` (this directory) — owner-facing walkthrough
**Why v4.0 not v3.3:** mesh introduces wire-format changes for cross-daemon communication and a new `mcp-conductor daemon start --mesh` flag; semver-major bump warranted.

---

## 1. Why this is its own PRD

The original v3-future PRD bundled mesh as v3.3 alongside hardening (v3.1) and capability completion (v3.2). On reflection mesh is a substantially different scope: it changes the daemon wire protocol, introduces distributed-systems concerns (clocks, partitions, replication), and benefits from a soak period on v3.1+v3.2 first. Deferring it to v4.0 lets v3.x stabilise and gives mesh design proper breathing room.

**v3.x continues uninterrupted.** v3.1 (hardening + tests + docs site + token-savings reporter + article 1) and v3.2 (capability completion + article 2) ship as planned. v4.0 mesh design starts only when v3.2 is in `@latest`.

---

## 2. Scope (lifted from former v3.3)

### Mesh blocks (M-prefix)

| Block | Scope | Notes |
|---|---|---|
| **M1** | Distributed lock primitive: replace single-host mutex with Tailscale-aware lock manager. Algorithm: Raft-lite or fencing tokens — pick simpler at planning. | Touches `src/daemon/shared-lock.ts`. New `src/daemon/distributed-lock.ts`. |
| **M2** | Distributed KV: replication via Tailscale peer discovery. Last-writer-wins with vector clocks for conflict detection. | Touches `src/daemon/shared-kv.ts`. New `src/daemon/distributed-kv.ts`. |
| **M3** | Tailscale peer discovery hardened: handle peer joins/leaves, partial failures, daemon-restart resilience. | Builds on existing `src/daemon/discovery.ts`. Windows daemon discovery still deferred. |
| **M4** | Multi-host integration tests: spin up 3 daemons in test (3 worker processes), assert cache sharing and lock serialisation. | New `test/integration/daemon/multi-host.test.ts`. |
| **M5** | Multi-host benchmark + soak: 3 connected daemons, simulated 8 agents distributed across them, 1-hour soak. | Recorded fixtures still — actual Tailscale not used in CI. |

### Docs + content blocks

| Block | Scope |
|---|---|
| **D-mesh-1** | Docs site: deployment guide for multi-host; Tailscale setup; topology recommendations. v4.0 version on selector. |
| **D-mesh-2** | Article (former article 3): "Multi-agent fleet: cross-host MCP coordination over Tailscale" (~2000 words). Multi-diagram set: topology, leader election, conflict resolution. |
| **D-mesh-3** (optional) | Article (former article 4): retrospective. Owner's call. |

### Release

| Block | Scope |
|---|---|
| **R-mesh** | Tag `v4.0.0` (mesh enables breaking-change opportunities for daemon wire format; assess at release time whether it stays in compat or earns the major). |

---

## 3. Pre-planning decisions (must answer before kickoff)

These are the questions raised in `mesh-explainer.md` §"Questions for you" — owner needs to think through these before M1 planning starts.

| Q | Question | Default if no answer |
|---|---|---|
| 1 | Fencing tokens vs Raft-lite for distributed locks? | Spike both for 2 days each, pick simpler. Default lean: fencing tokens (smaller code, no leader election complexity). |
| 2 | Network partition policy: when a host loses Tailscale, does its local KV/lock state continue to mutate (eventually-consistent rejoin) or freeze? | Lean: continue + LWW conflict resolution at rejoin. Documented limitation. |
| 3 | Cross-platform daemon: include Windows in v4.0 or stay macOS+Linux? | Lean: stay macOS+Linux; add Windows in v4.1. |
| 4 | KV size limits per key + total mesh-wide? | Lean: 1MB per key, 100MB mesh-wide. Hard caps with backpressure. |
| 5 | Version bump confirmation: mesh introduces wire-format additions only, or actual breaking changes? | Lean: v4.0.0 regardless — semver-major signals "this is the multi-host era" cleanly. |

Answer these before M1 planning kicks off (they shape the M1 design).

---

## 4. Design references

The owner-facing explainer at `mesh-explainer.md` (this directory, 2,691 words) covers:

- The problem: per-host duplicate fetches, per-host lock isolation across MBP/Mac Mini/iMac
- What "mesh" means: distributed KV + distributed locks
- Vector clocks (without oversimplifying)
- Fencing tokens vs Raft-lite tradeoff
- Why now (3-host setup that v3.0's single-host daemon can't coordinate)
- 4 worked use cases with named hosts
- ASCII before/after topology diagrams (SVG set comes with D-mesh-2 article)
- Scope limits, risks, decision questions

Read it as the entry point before M1 planning.

---

## 5. Sequencing relative to v3.x

```
NOW: v3.0.0-beta.2 on @beta on main
  ↓
v3.1: hardening + tests + docs + token-savings + article 1 → @latest
  ↓
v3.2: capability completion + article 2 → @latest
  ↓
[soak v3.2 on @latest for 2-4 weeks]
  ↓
v4.0 PLANNING: answer §3 questions, spike M1 algorithm choice
  ↓
v4.0 EXECUTION: M1-M5 + D-mesh-{1,2,3} + R-mesh → @next → @latest
```

No v4.0 work begins until v3.2 is on `@latest`. This gives the v3 architecture real-world bake time before introducing distributed-systems complexity.

---

## 6. What v4.0 is NOT

- Strong consistency / linearisability — explicit non-goal (LWW KV is eventual)
- Mesh-wide schedulers ("run this only on the Mac Mini because it has more RAM") — out of scope; agents pick their own hosts
- Public-internet mesh — Tailscale-only; wide-area mesh would need different security model
- Windows daemon discovery — deferred to v4.1
- Cross-platform mesh — macOS + Linux only in v4.0

---

## 7. Open items to revisit

- **Naming**: keep "mesh" or call it "fleet" / "cluster" / "swarm"? Affects docs + CLI surface. Decide before D-mesh-1.
- **Article timing**: article 3 (mesh deep-dive) is co-released with v4.0 per current plan. Could also publish a "designing the mesh" pre-article during planning to preview the architecture.
- **v3.x retrospective article (formerly D12)**: was optional in v3.3; now lives as a separate decision — could be standalone post-v3.2 article OR combined with v4.0 retrospective at the end.

---

*End of v4.0 PRD. Pickup signal: when v3.2 hits `@latest`, owner kicks off §3 question round.*
