# 02 — Sandbox Boot Cost: per-call `execute_code` overhead

Branch: `feat/lean-defaults`  
HEAD: `f12f5f5e219e99c5cd7552cebceabd18b4bcd17b`  
Measured: 2026-06-12  
Platform: darwin aarch64, Deno 2.7.14, Node v26.0.0

---

## 1. PROBLEM — per-call overhead in ms

Every call to `execute_code` spawns a fresh `deno` subprocess, waits for it to cold-boot, and tears it down. On this machine (M4 Max, Deno cache warm) that costs **~44 ms of pure sandbox overhead per call**, regardless of what the user code does. For the most common use case — a single backend tool call that takes 50–200 ms — Deno boot is 20–45% of total wall time.

A warm worker pool (`WorkerPool` / `PooledWorker`) is fully implemented, tested, and sitting in `src/runtime/pool/`. It is **not wired** to the live `execute_code` path. The pool reduces per-call sandbox overhead to under 1 ms over a stdout/stdin IPC pipe.

**Headline numbers (measured):**

| Path | Per-call sandbox overhead | Savings vs baseline |
|------|--------------------------|---------------------|
| Current: fresh `deno run` | **44 ms avg** (27–60 ms range) | — |
| First-ever call (DENO_DIR cold) | **154 ms** | — |
| Warm pool: IPC to existing Deno | **< 1 ms** (p50 = 0 ms, p95 = 1 ms) | ~43 ms / call |
| Node.js `vm.createContext` (no isolation) | **< 0.2 ms** | ~44 ms / call |

For a typical single-tool script with a 100 ms backend round-trip, the warm pool cuts total wall time from ~144 ms to ~101 ms — a **30% reduction** that the user (and Claude) feels directly as tool response latency.

The baseline benchmark's `execute_code` p50 of **52 ms** in `concurrency-2026-06-12.json` does **not** reflect this cost. That suite calls `mockExecuteCode()` — a `setTimeout(50ms)` — not a real Deno spawn. The 52 ms is the mocked backend latency, not sandbox overhead.

---

## 2. EVIDENCE — exact call chain from `execute_code` → spawn → result

### 2a. The live path: `DenoExecutor` only

`src/server/mcp-server.ts` line 270 constructs `DenoExecutor`:

```typescript
this.executor = new DenoExecutor(config.sandbox);
```

Line 905 calls it on every `execute_code` invocation:

```typescript
result = await this.executor.execute(code, {
  timeoutMs,
  bridgeUrl: this.bridge.getUrl(),
  servers: servers || [],
  stream: wantStream,
  signal: extra?.signal,
  executionId,
});
```

`WorkerPool` is imported from `runtime/index.js` by `mcp-server.ts` — but only `DenoExecutor` and `ExecutionResult` are destructured. The pool is a dead export.

### 2b. `DenoExecutor.execute()` — per-call sequence (src/runtime/executor.ts)

```
execute(code, options)
  ├── checkDeno()           — spawn 'deno --version', cached after first call (~16ms first; 0ms after)
  ├── generateSandboxCode() — synchronous string interpolation, ~15 KB template + user code (~0.01ms)
  ├── writeFileSync()       — writes exec_{id}.ts to /tmp/mcp-executor/ (~0.13–0.22ms)
  ├── runDeno()
  │     ├── spawn('deno', ['run', '--allow-net=localhost:9847,...', '--no-prompt',
  │     │         '--v8-flags=--max-old-space-size=128', filePath])
  │     │   OS fork + execve + Deno binary load + V8 init + SWC transpile
  │     │   + user code execution + stdout flush + process exit: ~27–60ms avg 44ms
  │     └── stdout regex parse: /__RESULT_START__\n...\n__RESULT_END__/
  └── unlinkSync()          — removes temp file (~0.06–0.13ms)
```

Total non-user-code overhead: **~44–45 ms** per call (warm DENO_DIR).

### 2c. Deno startup cost breakdown (measured)

The 44 ms Deno exec phase decomposes approximately as:

| Component | Est. ms | Notes |
|-----------|---------|-------|
| OS fork/exec | 3–5 | `spawn()` syscall to first event |
| Deno binary load | 2–3 | ELF/Mach-O load from disk |
| V8 initialization | 10–15 | V8 heap setup, built-in objects |
| Deno permissions parse | < 1 | `--allow-net=...` parsing |
| SWC TypeScript transpile | 1–2 | ~15 KB .ts file; SWC is near-instant |
| V8 module evaluation | < 1 | Class definitions, Proxy setup |
| User code execution | < 1 | `return 42;` trivial case |
| stdout flush + exit | 1–2 | `__RESULT_START__...` output |

TypeScript vs JavaScript measured overhead: **zero** — Deno 2's bundled SWC strips types in ~1 ms for a 15 KB file. Permission flags (`--allow-net=`) also add no measurable overhead vs no-permission mode.

### 2d. Temp file I/O per call

```
writeFileSync: avg 0.13–0.22 ms
unlinkSync:    avg 0.06–0.13 ms
Total I/O:     ~0.19–0.35 ms
```

This is negligible relative to the spawn cost but non-zero at high concurrency (100× concurrent = 35 ms of serial I/O if the tmpfs is under pressure).

### 2e. The warm pool path: `WorkerPool` / `PooledWorker` (src/runtime/pool/)

The pool spawns N persistent Deno workers at startup (`warmUp()`). Each worker runs a bootstrap script (`buildBootstrapScript`) that loops on `Deno.stdin.readable`, executing jobs via `new Function('mcp', '__ctx', code)()`.

IPC protocol: newline-delimited JSON over stdio:
```
host → worker stdin:  {"id":"job-0","code":"return 42;","context":{}}
worker → host stdout: {"id":"job-0","success":true,"result":42,"logs":[]}
```

Round-trip latency once the worker is running: **0–1 ms** (p50 = 0 ms, p95 = 1 ms across 20 sequential jobs measured).

Worker startup cost is paid once during `warmUp()` at process initialization, not per `execute_code` call.

### 2f. Security discrepancy between executor and pool

The current `DenoExecutor` uses tightly scoped permissions:

```
--allow-net=localhost:9847,127.0.0.1:9847    (bridge only)
no --allow-read, no --allow-env, no --allow-run
```

`PooledWorker.start()` (line 211–224) uses:

```
--allow-net     (unrestricted — all hosts)
--allow-read    (full filesystem read)
```

The pool's `new Function()` execution model (`worker.ts` line 142) is also weaker: user code runs in the **same Deno process** across all jobs. A job can call `Deno.env.get()`, `Deno.readFile()`, `Deno.openKv()`, and access prior jobs' closure state. The current `DenoExecutor` subprocess model provides full OS-level isolation between calls.

---

## 3. OPTIONS

### Option A — Wire the existing WorkerPool to the hot path (recommended, partial isolation retained)

The pool already exists and is tested. The connection is literally missing two lines in `mcp-server.ts`.

**Implementation sketch:**

```typescript
// In MCPExecutorServer constructor:
this.workerPool = new WorkerPool({
  size: config.runtime?.workerPool?.size ?? 4,
  preloadTypesDir: '',  // no typegen needed at runtime
  preloadHelpers: [],   // Phase 5 helpers optionally added here
  maxMemoryMb: config.sandbox.maxMemoryMb ?? 128,
  bridgeUrl: '',        // filled in after bridge starts
});
```

```typescript
// In MCPExecutorServer.start(), after bridge.start():
this.workerPool.updateBridgeUrl(this.bridge.getUrl());
await this.workerPool.warmUp();
```

```typescript
// In execute_code handler, replace this.executor.execute() with:
const workerResult = await this.workerPool.execute({ id: executionId, code, context: {} });
```

**Security fix required before shipping:** Restrict worker permissions to match `DenoExecutor`:
- Change `--allow-net` to `--allow-net=localhost:${bridgePort},127.0.0.1:${bridgePort}`
- Remove `--allow-read`
- Each worker processes one job at a time (sequential job loop), so per-job isolation is maintained at the worker granularity. Cross-call memory isolation requires per-job worker recycling (not per-request).

**Per-call isolation caveat:** The pool trades full per-call subprocess isolation for speed. `new Function()` jobs share a Deno heap: global variable leaks across calls are possible if user code writes to `globalThis`. For the trusted-caller model (Claude-generated code only) this is acceptable. For untrusted code it is not.

**Estimated savings:** ~43 ms per call. With pool size = 4, up to 4 concurrent calls service instantly; beyond that calls queue behind the 5-second `acquireTimeoutMs` deadline.

### Option B — Per-job Deno Worker (true per-call isolation, pool of processes)

Keep the subprocess-per-job model but use `deno run --unstable-worker-options` or Deno's built-in `Worker` API instead of Node.js `spawn`. Deno Workers share the parent process's already-initialized V8 instance and skip binary load + V8 init (~15–20 ms). This was considered in early Deno but the current `deno run` subprocess model does not share V8 state.

**Realistic estimate:** Deno Worker-per-job would save ~15–20 ms over fresh subprocess spawn. This requires restructuring the conductor itself to run inside Deno rather than Node.js — a large refactor. Not recommended.

### Option C — Deno snapshot startup

`deno compile` with `--snapshot` pre-initializes the V8 heap state. For a fixed bootstrap script this can reduce startup from ~44 ms to ~15–20 ms (Deno's own benchmarks report 50–60% startup improvement for snapshot-compiled programs).

Requires: pre-compiling a fixed sandbox entrypoint and bundling it with the package. The sandbox code template is dynamically generated per-call (user code injected at `${userCode}` in `generateSandboxCode`), so snapshotting the fixed preamble while injecting code at runtime would require a stdin-driven architecture similar to Option A.

**Net complexity:** High (compile step in CI, separate binary distribution). Savings: ~20–25 ms per call vs current. Not recommended over Option A which achieves greater savings more cleanly.

### Option D — In-process `vm.createContext` (no sandbox, trusted-path only)

Node.js `vm.createContext` + `vm.Script.runInContext()` runs synchronously in the host process with ~0.2 ms overhead. For single-tool-call scripts where the code pattern is statically verifiable (`return mcp.server(x).call(y, z)`) this provides zero-overhead execution.

```typescript
// Hot path for single-tool scripts detected by static analysis
const vm = require('vm');
const ctx = vm.createContext({ mcp, result: undefined });
await new vm.Script(`(async () => { result = await (async () => { ${code} })(); })()`).runInNewContext(ctx, { timeout: timeoutMs });
```

**Security:** None. User code runs in the host Node.js process with full access to `require`, `process`, `fs`. Only viable if the caller (Claude) is fully trusted and code injection is not a threat model.

**Estimated savings:** ~44 ms per call. Appropriate only for a "trusted hot path" annotation, not as a general replacement.

**Proposed trigger:** If `code` matches the pattern `/^return await mcp\.server\(['"]\w+['"]\)\.call\(['"]\w+['"](?:,\s*\{[^}]*\})?\);?$/` (single passthrough call, no mcp.compact/batch/loop), route to `vm` path and skip Deno entirely. This covers the high-frequency single-lookup use case from passthrough-call migration.

### Option E — Deno stdin command stream (persistent single process, no pool)

A variant of Option A with pool size = 1. One Deno process runs continuously; all execute_code calls serialize through it. This eliminates per-call spawn cost entirely but removes all parallelism.

At 10 concurrent `execute_code` calls (each 100 ms backend), serial throughput = 1 call/100 ms = 10/s. Pool size 4 = 40/s with same backend time. The bridge-ceiling benchmark shows the system handles ~155 RPS under load — serialization at pool size 1 would be the bottleneck for any concurrent usage pattern.

**Verdict:** Pool size = 1 is inferior to pool size ≥ 4. Not recommended.

---

## 4. IMPACT — projected per-call savings

### Primary (Option A: warm pool, size 4)

| Scenario | Current wall ms | With pool wall ms | Saved ms | % reduction |
|----------|----------------|-------------------|----------|-------------|
| Trivial (return 42) | ~44 | ~1 | ~43 | ~98% |
| Single tool call, 50ms backend | ~94 | ~51 | ~43 | ~46% |
| Single tool call, 100ms backend | ~144 | ~101 | ~43 | ~30% |
| Single tool call, 500ms backend | ~544 | ~501 | ~43 | ~8% |
| First-ever call (DENO_DIR cold) | ~154 | ~43 at startup* | ~111 | ~72% |

*Warmup cost paid at `warmUp()` during server startup, not at first user call.

### Secondary effects

- **Concurrency headroom:** With pool size 4, 4 simultaneous `execute_code` calls run in parallel. Current model uses `maxConcurrentProcesses = 8` which would require 8 concurrent Deno processes (8 × 44 ms spawn overhead = 352 ms of wasted wall time per concurrent batch).
- **Memory:** 4 warm workers at 128 MB each = 512 MB baseline. Current model: 0 MB idle, spikes to N × 128 MB under load. Pool is more predictable.
- **Temp file I/O eliminated:** `/tmp/mcp-executor/exec_*.ts` write+unlink removed per call.
- **Worker recycle overhead:** After `maxJobsPerWorker = 100` jobs (configurable), a replacement is spawned asynchronously. No call is blocked during recycle.

### Secondary (Option D: vm hot path for trivial single-tool calls)

If even 30% of `execute_code` calls are detectable as trivial single-tool-call scripts, routing them to `vm.createContext` saves ~44 ms per call on that fraction with zero infrastructure change. However, this introduces a security boundary mismatch that needs documentation and an explicit opt-in.

---

## 5. RECOMMENDED PATH

**Ship Option A in two steps.**

**Step 1 (immediate, low risk): wire the pool with a feature flag**

Add `runtime.workerPool.enabled` (default `false`) to `WorkerPoolConfig`. When enabled, `MCPExecutorServer.start()` calls `workerPool.warmUp()` and the `execute_code` handler routes to the pool. `DenoExecutor` remains as fallback when the pool is full or disabled.

Fix the security issues first:
1. In `PooledWorker.start()`: change `'--allow-net'` to `'--allow-net=localhost:${bridgePort},127.0.0.1:${bridgePort}'`.
2. In `PooledWorker.start()`: remove `'--allow-read'`.

These two lines make the pool's security posture match `DenoExecutor` (network-isolated to bridge only).

**Step 2 (follow-on): make the pool the default and remove the flag**

After one release cycle of testing with the flag on, set `runtime.workerPool.enabled: true` as the default. Retire the old `DenoExecutor.execute()` path as fallback-only (for environments where Deno is not pre-warmed or the pool has failed all workers).

**Do not ship Option D** without an explicit security review and an opt-in annotation (`trusted_mode: true`) on the `execute_code` schema. The vm path removes all sandbox isolation.

**Defer Option C** (snapshot). The pool achieves better savings with less complexity.

---

## Key files

- `src/runtime/executor.ts` — `DenoExecutor` (live path, 1151 lines)
- `src/runtime/pool/worker.ts` — `PooledWorker` lifecycle (401 lines)
- `src/runtime/pool/worker-pool.ts` — `WorkerPool` with queue + recycle (300 lines)
- `src/runtime/pool/recycle.ts` — age/job-count eviction policy (84 lines)
- `src/runtime/pool/index.ts` — exports (pool is exported but never imported by server)
- `src/config/schema.ts` lines 186–201 — `WorkerPoolConfig` schema (defined, never applied)
- `src/server/mcp-server.ts` line 270 — `new DenoExecutor(config.sandbox)` (the gap)
- `test/stress/execute-code-concurrency.test.ts` — S1 benchmark uses `mockExecuteCode()` (50 ms `setTimeout`), **not real Deno spawn**; reported p50 ≈ 52 ms is mock backend latency, not spawn cost
