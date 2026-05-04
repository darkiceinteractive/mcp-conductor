# MCP Conductor v3 — Product Requirements Document

**Status:** Draft for implementation
**Owner:** Matt Crombie / Dark Ice Interactive
**Implementer:** Claude Code (multi-agent: 6–8 concurrent)
**Timeline:** 1-week sprint, starting today
**Repo:** `/Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice`
**Branch:** `feature/v3`
**Baseline:** `@darkiceinteractive/mcp-conductor@2.0.0-alpha.1`

---

## 1. Vision

MCP Conductor v2 achieves an average 94.3% token reduction by routing all MCP traffic through a Deno sandbox so only compact summaries reach Claude. v3 builds on that foundation to:

1. Push token reduction toward ~98% via caching, delta encoding, and exhaustive type-driven schema knowledge
2. Cut `execute_code` latency from ~150ms cold to <10ms warm via sandbox pool, connection pool, and result cache
3. Eliminate hangs from flaky backend MCPs (especially `ibkr-mcp-server`) via per-server reliability profiles, retry, timeout, and circuit breakers
4. Enable shared infrastructure across 6–8 concurrent Claude Code agents via daemon mode and shared KV/lock primitives
5. Turn 68 personal skills (`$CLAUDE_SKILLS_DARKICE`) into composable sandbox primitives
6. Add native sandbox helpers (`compact`, `summarize`, `delta`, `findTool`) so Claude writes shorter, cleaner code in `execute_code`
7. Ship observability (cost predictor, hot-path profiler, replay) that earns its keep

## 2. Success metrics

| Metric | v2 baseline | v3 target |
|---|---|---|
| Avg token reduction (cache miss) | 94.3% | ≥96% |
| Avg token reduction (cache hit, warm) | 94.3% | ≥99% |
| Median `execute_code` latency, cold | ~150ms | ≤30ms |
| Median `execute_code` latency, warm | ~150ms | ≤10ms |
| Hangs from backend MCP failure | unbounded | 0 (all calls bounded by timeout) |
| Cross-agent cache hit rate (multi-agent workload) | 0% (no sharing) | ≥40% |
| Test coverage | 82% | ≥85% |
| Existing tests passing | 673 / 673 | 673 / 673 |

## 3. Out of scope (deferred to v3.1+)

- WASM module support inside sandbox
- Sub-LLM call planning / auto-rewriting `execute_code` for parallelism
- gRPC bridge (HTTP+JSON stays for v3)
- GUI/dashboard for metrics (CLI/JSON output only)
- Cross-platform daemon discovery on Windows (macOS + Linux first)
- Lyrics, song, or audio-related MCP servers (NA — listed for completeness only)

## 4. Architecture

```
                    [Claude / Claude Code agent]
                              │
                              ▼
              ┌───────────────────────────────┐
              │       MCP Conductor v3        │
              │                               │
              │  Tool registry (NEW)          │  ← typed catalog, .d.ts gen, validation
              │  Cache layer (NEW)            │  ← LRU + TTL + disk + delta
              │  Sandbox pool (UPGRADED)      │  ← warm Deno workers + native helpers + skills
              │  Reliability gateway (NEW)    │  ← retry · timeout · circuit breaker
              │  Connection pool (NEW)        │  ← persistent stdio · multiplexed · pre-warmed
              │  HTTP bridge (existing)       │
              └───────────────┬───────────────┘
                              ▼
        [GitHub] [Filesystem] [IBKR] [Memory] [...]
```

A daemon-mode variant (Phase 6) accepts connections from multiple Claude Code agents over Unix sockets / Tailscale, sharing all of the above.

---

## 5. Implementation phases

> **Convention:** every phase ends with `npm run test:run` clean, lint clean, and `npm run build` clean. Coverage must not drop below 82%. Existing public API in `src/index.ts` and the 11 currently-exposed MCP tools (execute_code, list_servers, discover_tools, get_metrics, set_mode, compare_modes, add_server, remove_server, update_server, reload_servers, passthrough_call) MUST remain backwards-compatible.

### Phase 0 — Setup (today, ~30 minutes)

**Goal:** establish v3 branch, dependencies, directory structure.

**Tasks:**
- Create branch `feature/v3` from `main`
- Add dependencies: `json-schema-to-typescript@^15`, `ajv@^8`, `lru-cache@^11`, `cbor-x@^1`, `nanoid@^5`, `p-queue@^8`
- Add dev dependencies: `@types/node` if newer needed, `vitest` already present
- Update `tsconfig.json` to include new directories
- Create empty stub directories with `.gitkeep`:
  - `src/registry/`
  - `src/registry/types/` (add to `.gitignore`)
  - `src/cache/`
  - `src/reliability/`
  - `src/runtime/pool/`
  - `src/daemon/`
  - `src/observability/`
  - `docs/v3/`
- Copy this PRD to `_plans/v3/PRD.md`
- Run `npm install`, then `npm run build && npm run test:run` — both green
- Commit: `chore(v3): scaffold directories and dependencies`

**Acceptance:**
- [ ] `npm run build` passes
- [ ] `npm run test:run` passes (673/673)
- [ ] `npm run lint` passes
- [ ] Branch pushed to remote

---

### Phase 1 — Tool Registry & Type Generation (today, ~6 hours)

**Goal:** build the authoritative tool catalog with auto-generated TypeScript types and upstream schema validation.

**Files to create:**

```
src/registry/
├── index.ts              # public exports
├── registry.ts           # ToolRegistry class
├── typegen.ts            # JSON Schema → .d.ts converter
├── validator.ts          # input validation (ajv)
├── snapshot.ts           # disk persistence of catalog
├── events.ts             # RegistryEvent typedef + emitter
└── tests/
    ├── registry.test.ts
    ├── typegen.test.ts
    ├── validator.test.ts
    └── snapshot.test.ts
```

**Public API (`src/registry/index.ts`):**

```typescript
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  $ref?: string;
  // ... standard JSON Schema draft 7+
}

export interface ToolDefinition {
  server: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  // Conductor-extension metadata (optional)
  cost?: 'low' | 'medium' | 'high';
  cacheable?: boolean;
  cacheTtl?: number;          // ms
  reliability?: ReliabilityProfile;
}

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
}

export type RegistryEventType =
  | 'tool-added'
  | 'tool-removed'
  | 'tool-updated'
  | 'server-connected'
  | 'server-disconnected';

export interface RegistryEvent {
  type: RegistryEventType;
  server: string;
  tool?: string;
  before?: ToolDefinition;
  after?: ToolDefinition;
  at: number;  // epoch ms
}

export interface RegistryOptions {
  bridge: BackendBridge;          // existing src/bridge component
  snapshotPath?: string;
  typesDir?: string;
  validateInputs?: boolean;       // default true
  regenerateOnConnect?: boolean;  // default true
}

export class ToolRegistry {
  constructor(options: RegistryOptions);

  /** Initialize from connected backends; returns full catalog. */
  refresh(): Promise<ToolDefinition[]>;

  /** Look up a single tool. */
  getTool(server: string, name: string): ToolDefinition | null;

  /** All tools across all servers. */
  getAllTools(): ToolDefinition[];

  /** Tools for a specific server. */
  getServerTools(server: string): ToolDefinition[];

  /** Validate input args against the tool's input schema. */
  validateInput(server: string, name: string, args: unknown): ValidationResult;

  /** Generate combined TypeScript declarations for sandbox import. */
  generateTypes(): Promise<string>;

  /** Write generated types to disk for sandbox preload; returns file paths. */
  writeTypesToDir(dir: string): Promise<string[]>;

  /** Subscribe to registry change events. */
  watch(callback: (event: RegistryEvent) => void): { unsubscribe: () => void };

  /** Persist current catalog snapshot to disk. */
  saveSnapshot(path?: string): Promise<void>;

  /** Load a previously saved snapshot. */
  loadSnapshot(path?: string): Promise<void>;

  /** Update conductor-extension metadata for a tool. */
  annotate(server: string, name: string, metadata: Partial<ToolDefinition>): void;
}
```

**Type generation contract:**

For each backend, produce one `.d.ts` file in `<typesDir>/<server>.d.ts`:

```typescript
// Auto-generated. Do not edit.
export namespace github {
  /** List issues in a repo. */
  export interface list_issues_Input {
    /** Repository owner */
    owner: string;
    repo: string;
    state?: "open" | "closed" | "all";
    labels?: string[];
  }

  export interface Issue {
    id: number;
    number: number;
    title: string;
    state: "open" | "closed";
    body: string | null;
    labels: Array<{ name: string; color: string }>;
    /** ISO 8601 timestamp */
    created_at: string;
  }

  export type list_issues_Output = Issue[];
}
```

Plus a combined `<typesDir>/_index.d.ts`:

```typescript
import type { github } from './github.js';
import type { filesystem } from './filesystem.js';
// ... etc

declare global {
  namespace mcp {
    namespace tools {
      const github: {
        list_issues(args: github.list_issues_Input): Promise<github.list_issues_Output>;
        // ...
      };
      // ...
    }
  }
}
export {};
```

**Behavior:**

1. On conductor startup, after all backends connect, `registry.refresh()` is called by `src/index.ts`
2. For each backend, fetch `tools/list`. For each tool, run `inputSchema` (and `outputSchema` if present) through `json-schema-to-typescript`
3. Aggregate output into `<typesDir>/<server>.d.ts` and `_index.d.ts`
4. Sandbox runtime preloads these via Deno's `--config` flag with an import map (`src/runtime/sandbox-config.ts`)
5. Validation hook in `src/bridge/`: BEFORE any backend call, `registry.validateInput` runs synchronously; if invalid, return structured error WITHOUT round-trip
6. `discover_tools` MCP tool now reads from registry instead of querying backends per-call

**Hot reload:**

- When a backend reconnects, re-fetch `tools/list` and diff against current registry
- Emit `tool-added`, `tool-removed`, `tool-updated` events
- Regenerate affected `.d.ts` files within 500ms
- Sandbox workers see new types on next worker recycle (Phase 4 will handle this)

**Configuration additions in `~/.mcp-conductor.json`:**

```json
{
  "registry": {
    "snapshotPath": "~/.mcp-conductor/registry-snapshot.json",
    "typesDir": "~/.mcp-conductor/types",
    "validateInputs": true,
    "regenerateOnConnect": true
  }
}
```

**Acceptance criteria:**

- [ ] `registry.refresh()` populates catalog from all connected backends in <2s for 100 tools
- [ ] Generated `.d.ts` is syntactically valid (parses with `tsc --noEmit`)
- [ ] Generated types include JSDoc comments from `description` fields
- [ ] Validation catches: missing required fields, type mismatches, enum violations, `additionalProperties: false` violations
- [ ] Validation completes in <1ms p99 for typical schemas
- [ ] Hot reload: adding a tool to a mock backend, tool appears in registry within 1s
- [ ] Snapshot save/load roundtrips losslessly
- [ ] Existing `discover_tools` tool now reads from registry; no backend round-trip needed
- [ ] Existing `execute_code` calls are unaffected (no breakage)

**Test cases to write:**

```typescript
// registry.test.ts
test('refresh populates catalog from connected backends');
test('refresh handles backend that throws during tools/list');
test('getTool returns null for unknown tool');
test('getAllTools returns flat list across servers');
test('getServerTools filters by server');
test('hot reload: tool-added event fires when backend adds tool');
test('hot reload: tool-removed event fires when tool disappears');
test('hot reload: tool-updated event fires when schema changes');
test('annotate: metadata persists across refresh');

// typegen.test.ts
test('converts simple object schema to interface');
test('converts enum to TS union');
test('converts array of strings');
test('converts nullable types correctly');
test('converts $ref to local type alias');
test('preserves description as JSDoc');
test('handles recursive schemas');
test('handles oneOf / anyOf / allOf');
test('output validates with tsc --noEmit');
test('combined index references all server namespaces');

// validator.test.ts
test('catches missing required field');
test('catches type mismatch');
test('catches enum violation');
test('respects additionalProperties:false');
test('validates within 1ms for 100-property schema');
test('handles array validation');
test('handles nested object validation');

// snapshot.test.ts
test('save and load roundtrip preserves catalog');
test('snapshot survives process restart');
test('snapshot version mismatch falls back to refresh');
```

**Rollback plan:** if validation introduces false positives, set `validateInputs: false` in config.

---

### Phase 2 — Cache Layer (Day 2, ~6 hours)

**Goal:** dramatic reduction in repeated tool-call cost via three-tier caching with content addressing and delta encoding.

**Files to create:**

```
src/cache/
├── index.ts              # public exports
├── lru.ts                # in-memory LRU
├── disk.ts               # persistent disk cache (CBOR-encoded)
├── key.ts                # content addressing (stable JSON hash)
├── delta.ts              # delta encoding for repeat queries
├── policy.ts             # per-tool TTL policy
├── cache.ts              # CacheLayer composition (lru + disk)
└── tests/
    ├── lru.test.ts
    ├── disk.test.ts
    ├── key.test.ts
    ├── delta.test.ts
    └── cache.test.ts
```

**Public API:**

```typescript
export interface CacheKey {
  server: string;
  tool: string;
  argsHash: string;  // sha256 of stable-stringified args
}

export interface CacheHit {
  value: unknown;
  storedAt: number;
  source: 'memory' | 'disk';
  staleness: number;  // ms since stored
}

export interface CacheStats {
  memoryHits: number;
  diskHits: number;
  misses: number;
  evictions: number;
  bytesInMemory: number;
  bytesOnDisk: number;
}

export interface CacheLayerOptions {
  registry: ToolRegistry;
  diskDir?: string;
  maxMemoryBytes?: number;       // default 100MB
  maxDiskBytes?: number;         // default 2GB
  staleWhileRevalidate?: boolean; // default true
}

export class CacheLayer {
  constructor(options: CacheLayerOptions);

  get(server: string, tool: string, args: unknown): Promise<CacheHit | null>;
  set(server: string, tool: string, args: unknown, result: unknown, options?: { ttl?: number }): Promise<void>;
  invalidate(server: string, pattern?: string): Promise<number>;
  delta(server: string, tool: string, args: unknown, current: unknown): Promise<DeltaResult>;
  stats(): CacheStats;
  clear(): Promise<void>;
}

export interface DeltaResult {
  unchanged: boolean;
  added?: unknown[];
  removed?: unknown[];
  modified?: Array<{ before: unknown; after: unknown }>;
  full?: unknown;  // returned when delta is larger than full
}
```

**Cache key format:** `${server}:${tool}:${sha256(stableJsonStringify(args))}`

`stableJsonStringify`: sorts object keys deterministically, normalizes whitespace.

**Default TTL policy (`src/cache/policy.ts`, configurable):**

| Pattern | TTL | Notes |
|---|---|---|
| `list_*`, `search_*` | 5 min | listings change infrequently |
| `get_*` (id-based) | 1 min | usually identity-stable |
| `read_file` | mtime check | invalidate when file changes |
| `*_create`, `*_update`, `*_delete` | 0 (never cache) | mutations |
| `query_*` (DB) | 30 sec | balance freshness/perf |
| default | 30 sec | safe default |

Configurable per-server in `~/.mcp-conductor.json`:

```json
{
  "cache": {
    "diskDir": "~/.mcp-conductor/cache",
    "maxMemoryBytes": 104857600,
    "maxDiskBytes": 2147483648,
    "staleWhileRevalidate": true,
    "policies": {
      "github": {
        "list_issues": 60000,
        "list_pull_requests": 60000,
        "get_issue": 30000
      },
      "ibkr": {
        "get_quote": 1000,
        "get_portfolio": 5000
      }
    }
  }
}
```

**Behavior:**

1. Bridge calls `cache.get(server, tool, args)` before backend call
2. Cache miss → call backend, store result via `cache.set()`, return result
3. Cache hit (fresh) → return immediately
4. Cache hit (stale, SWR enabled) → return stale, refresh in background
5. Mutation tools (per policy) skip cache entirely
6. Disk cache uses CBOR (`cbor-x`) for compactness; rotates oldest when over `maxDiskBytes`
7. `delta()` API: if Claude wants "what changed since last call", we compute diff and return only delta — orders of magnitude smaller for incremental work

**Sandbox-side delta API:**

```typescript
// Inside execute_code:
const diff = await mcp.cache.delta('github', 'list_issues', args);
if (diff.unchanged) return { status: 'no changes' };
return { added: diff.added?.length, removed: diff.removed?.length };
```

**Acceptance criteria:**

- [ ] Hit rate ≥80% on benchmark "repeat call" suite
- [ ] Disk cache survives process restart
- [ ] Stale-while-revalidate: returns cached value AND refreshes in background
- [ ] LRU eviction kicks in when memory cache > `maxMemoryBytes`
- [ ] Disk cache rotates when > `maxDiskBytes`
- [ ] `delta()` returns smaller payload than full result for ≥90% of incremental updates in benchmark suite
- [ ] Cache keys stable across runs (same args → same hash)
- [ ] Mutations bypass cache (verified by integration test)

**Test cases:**

```typescript
// lru.test.ts
test('get returns null on miss');
test('set then get returns value');
test('LRU evicts oldest when over capacity');
test('TTL expiry returns null');

// disk.test.ts
test('persists across instance restart');
test('CBOR encoding round-trips lossless');
test('rotates oldest when over maxDiskBytes');
test('parallel writes do not corrupt store');

// key.test.ts
test('same args produce same hash regardless of key order');
test('different args produce different hashes');
test('large nested objects hash deterministically');

// delta.test.ts
test('detects added items in array result');
test('detects removed items');
test('detects modified items');
test('returns unchanged: true for identical results');
test('returns full result when delta would be larger');

// cache.test.ts
test('memory hit before disk hit');
test('disk hit promoted to memory');
test('stale-while-revalidate returns cached, triggers background fetch');
test('mutation policy skips cache');
test('invalidate by pattern removes matching keys');
test('stats reflect hits, misses, evictions');
```

---

### Phase 3 — Reliability Gateway (Day 3, ~5 hours)

**Goal:** eliminate hangs and unbounded failures from flaky backends (esp. `ibkr-mcp-server`'s known `get_quotes_batch` nulls and `get_portfolio` hangs).

**Files to create:**

```
src/reliability/
├── index.ts              # public exports
├── profile.ts            # ReliabilityProfile typedef + defaults
├── breaker.ts            # circuit breaker (closed/open/half-open)
├── retry.ts              # exponential backoff retry
├── timeout.ts            # call timeout enforcement
├── gateway.ts            # ReliabilityGateway composition
└── tests/
    ├── breaker.test.ts
    ├── retry.test.ts
    ├── timeout.test.ts
    └── gateway.test.ts
```

**Public API:**

```typescript
export interface ReliabilityProfile {
  timeoutMs?: number;                    // default 10000
  retries?: number;                      // default 0 for mutations, 2 for reads
  retryDelayMs?: number;                 // initial delay; doubles each attempt; default 100
  retryMaxDelayMs?: number;              // ceiling; default 5000
  circuitBreakerThreshold?: number;      // failure ratio 0–1; default 0.5
  circuitBreakerWindowMs?: number;       // rolling window; default 60000
  circuitBreakerMinCalls?: number;       // minimum calls before tripping; default 10
  halfOpenProbeIntervalMs?: number;      // default 30000
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ReliabilityStats {
  byServer: Record<string, {
    totalCalls: number;
    successes: number;
    failures: number;
    timeouts: number;
    retries: number;
    circuitState: CircuitState;
    lastTrip?: number;
  }>;
}

export class ReliabilityGateway {
  constructor(options: { registry: ToolRegistry; defaultProfile?: ReliabilityProfile });

  /** Wrap a backend call with full reliability protection. */
  call<T>(server: string, tool: string, fn: () => Promise<T>): Promise<T>;

  getCircuitState(server: string): CircuitState;
  getStats(): ReliabilityStats;
  resetCircuit(server: string): void;
}
```

**Behavior:**

1. Every backend call routes through `gateway.call()`
2. Profile resolved from: tool-level annotation → server-level config → global default
3. Timeout: `Promise.race([fn(), reject after timeoutMs])`. On timeout, abort the underlying call (where possible — depends on bridge API; design bridge to accept AbortSignal in Phase 4)
4. Retry: on retryable failure (timeout, network error, 5xx-equivalent), exponential backoff up to `retries` attempts. Mutations (`*_create`, `*_update`, `*_delete`) DO NOT retry by default
5. Circuit breaker: track success/failure ratio in rolling window; if ratio drops below threshold AND minimum calls met, trip OPEN. In OPEN state, fail fast with `CircuitOpenError`. After `halfOpenProbeIntervalMs`, allow ONE probe call (HALF-OPEN). Probe success → CLOSED; probe failure → OPEN again
6. Structured errors: `TimeoutError`, `RetryExhaustedError`, `CircuitOpenError`. All include `server`, `tool`, `attempts`, last underlying error

**Configuration:**

```json
{
  "reliability": {
    "default": {
      "timeoutMs": 10000,
      "retries": 2,
      "circuitBreakerThreshold": 0.5
    },
    "perServer": {
      "ibkr": {
        "timeoutMs": 5000,
        "retries": 3,
        "circuitBreakerThreshold": 0.4,
        "circuitBreakerMinCalls": 5
      },
      "github": {
        "timeoutMs": 15000,
        "retries": 2
      }
    },
    "perTool": {
      "ibkr.get_portfolio": {
        "timeoutMs": 8000,
        "retries": 1
      }
    }
  }
}
```

**Acceptance criteria:**

- [ ] No execute_code call hangs >timeoutMs + max retry delay
- [ ] Mutations do not retry by default
- [ ] Circuit opens within 1s of crossing threshold; closes after successful probe
- [ ] Structured errors include `server`, `tool`, `attempts`
- [ ] Reliability stats accurate within 1% of ground truth in load test
- [ ] IBKR test fixture (simulating `get_portfolio` hang) terminates within 8s and surfaces TimeoutError to sandbox

**Test cases:**

```typescript
// breaker.test.ts
test('starts closed');
test('trips open when failure ratio exceeded');
test('does not trip below minimum call threshold');
test('rolls window correctly');
test('half-open allows single probe');
test('probe success returns to closed');
test('probe failure returns to open');

// retry.test.ts
test('does not retry mutations');
test('retries on timeout');
test('retries on network error');
test('exponential backoff doubles delay');
test('respects max delay ceiling');
test('throws RetryExhaustedError after max attempts');

// timeout.test.ts
test('rejects after timeoutMs');
test('aborts underlying call when AbortSignal supported');
test('does not affect successful fast calls');

// gateway.test.ts
test('full pipeline: timeout → retry → circuit trip');
test('circuit-open returns CircuitOpenError without calling fn');
test('stats reflect ground truth across mixed workload');
test('IBKR-style hang fixture terminates within budget');
```

---

### Phase 4 — Connection Pool & Warm Sandbox Pool (Day 4, ~6 hours)

**Goal:** kill cold-start latency. Persistent stdio to backends, warm Deno workers ready to execute.

**Files to create:**

```
src/bridge/
├── pool.ts               # NEW — backend connection pool

src/runtime/pool/
├── index.ts              # public exports
├── worker-pool.ts        # warm Deno worker management
├── worker.ts             # individual worker lifecycle
├── recycle.ts            # recycle policy (memory/age/error)
└── tests/
    ├── worker-pool.test.ts
    └── recycle.test.ts
```

**Public API:**

```typescript
// src/bridge/pool.ts
export interface ConnectionPoolOptions {
  minConnectionsPerServer?: number;  // default 1
  maxConnectionsPerServer?: number;  // default 4
  idleTimeoutMs?: number;            // default 300000 (5 min)
  acquireTimeoutMs?: number;         // default 5000
}

export class ConnectionPool {
  constructor(options: ConnectionPoolOptions);

  /** Acquire a connection for a server (multiplexed when possible). */
  acquire(server: string): Promise<PooledConnection>;

  /** Release a connection back to the pool. */
  release(connection: PooledConnection): void;

  /** Drain and shut down. */
  shutdown(): Promise<void>;

  stats(): PoolStats;
}
```

```typescript
// src/runtime/pool/worker-pool.ts
export interface WorkerPoolOptions {
  size?: number;                     // default 4
  maxJobsPerWorker?: number;         // recycle after N; default 100
  maxAgeMs?: number;                 // recycle after age; default 600000 (10 min)
  preloadTypesDir: string;           // from registry
  preloadHelpers: boolean;           // default true
}

export interface WorkerJob {
  code: string;
  context: Record<string, unknown>;
  signal?: AbortSignal;
}

export class WorkerPool {
  constructor(options: WorkerPoolOptions);

  /** Acquire a warm worker, run code, release. */
  execute<T>(job: WorkerJob): Promise<T>;

  size(): number;
  busyCount(): number;
  idleCount(): number;
  shutdown(): Promise<void>;
}
```

**Behavior — Connection Pool:**

1. At startup, spawn `minConnectionsPerServer` connections per backend
2. On `acquire()`, return idle connection or spawn new (up to max)
3. On `release()`, mark idle; idle timer kicks in
4. After `idleTimeoutMs`, shut connection down to free resources
5. Multiplex JSON-RPC requests on same stdio when backend supports it (track request IDs)
6. Auto-respawn on backend crash; failed in-flight calls return error

**Behavior — Worker Pool:**

1. At startup, spawn `size` warm Deno workers
2. Each worker preloads:
   - Generated `.d.ts` from registry typesDir
   - Native helpers (`compact`, `summarize`, `delta`, `findTool` — Phase 5)
   - The `mcp` global object wired to bridge
3. `execute(job)` picks an idle worker, sends job over IPC, awaits result, releases worker
4. Worker recycles after `maxJobsPerWorker` jobs OR `maxAgeMs` age OR uncaught error
5. Recycle is async — pool maintains capacity by spawning replacement before terminating

**Configuration:**

```json
{
  "runtime": {
    "workerPool": {
      "size": 4,
      "maxJobsPerWorker": 100,
      "maxAgeMs": 600000
    },
    "connectionPool": {
      "minConnectionsPerServer": 1,
      "maxConnectionsPerServer": 4,
      "idleTimeoutMs": 300000
    }
  }
}
```

**Acceptance criteria:**

- [ ] First `execute_code` call after startup completes in <30ms (worker already warm)
- [ ] Subsequent calls complete in <10ms median (cache miss path)
- [ ] Worker recycle does not interrupt in-flight jobs
- [ ] Connection pool limits respected under burst load
- [ ] Backend crash → automatic respawn within 1s
- [ ] No memory leak after 1000 jobs (worker memory stable across recycles)

**Test cases:**

```typescript
// worker-pool.test.ts
test('warm pool: first execute is fast');
test('size respected under concurrent load');
test('worker recycles after maxJobsPerWorker');
test('worker recycles after maxAgeMs');
test('uncaught error in worker recycles it');
test('shutdown drains in-flight jobs');
test('1000 jobs: no memory growth');

// recycle.test.ts
test('recycle replaces before terminate');
test('idle workers preferred over busy on acquire');

// pool.test.ts (bridge)
test('acquire under min spawns new connection');
test('acquire over max blocks until release');
test('idle timeout shuts connection down');
test('multiplexed requests track correct response by id');
test('backend crash triggers respawn');
```

---

### Phase 5 — Sandbox Capabilities (Day 5, ~6 hours)

**Goal:** native helpers (`compact`, `summarize`, `delta`, `findTool`) + skills wiring + vector tool index.

**Files to create:**

```
src/runtime/helpers/
├── index.ts
├── compact.ts            # field selection & trimming
├── summarize.ts          # heuristic summarization
├── delta.ts              # cross-call diff (uses cache.delta)
├── budget.ts             # token budget enforcement
└── tests/

src/runtime/findtool/
├── index.ts
├── vector-index.ts       # in-memory vector store (LanceDB optional via Tailscale)
├── embed.ts              # tiny embedding model (or remote)
└── tests/

src/skills/
└── (extend existing skills-engine.ts to load from $CLAUDE_SKILLS_DARKICE)
```

**Public API — sandbox-side `mcp` global additions:**

```typescript
// Inside execute_code, Claude can call:

mcp.compact<T>(data: T, options: {
  fields?: string[];          // dot-paths; only these fields kept
  maxItems?: number;          // truncate arrays
  maxDepth?: number;
  maxStringLength?: number;
}): T;

mcp.summarize(data: unknown, options: {
  maxTokens: number;
  style?: 'list' | 'paragraph' | 'json';
}): string;

mcp.budget<T>(maxTokens: number, fn: () => T | Promise<T>): Promise<T>;
// Auto-trims fn's return to fit budget. Throws BudgetExceededError if untrimmable.

mcp.delta<T>(server: string, tool: string, args: unknown, current: T): Promise<DeltaResult<T>>;
// Wraps cache.delta from Phase 2.

mcp.findTool(query: string, options?: {
  topK?: number;
  serverFilter?: string[];
}): Promise<Array<{
  server: string;
  tool: string;
  description: string;
  score: number;
}>>;

skills.run(name: string, args: unknown): Promise<unknown>;
skills.list(filter?: { category?: string; tags?: string[] }): Promise<Array<{ name: string; category: string; description: string }>>;
skills.findByQuery(query: string, topK?: number): Promise<Array<{ name: string; score: number }>>;
```

**Behavior — `compact`:**

```typescript
// Field selection (jq-style):
const lean = mcp.compact(issues, {
  fields: ['id', 'title', 'state', 'labels.name'],
  maxItems: 20
});
// Returns: [{ id, title, state, labels: [{name}] }, ...] capped at 20
```

**Behavior — skills wiring:**

1. `SkillsEngine.config.skillsDir` reads from env: `process.env.CLAUDE_SKILLS_DARKICE || './skills'`
2. Engine watches the directory; hot-reloads skill manifests on change (existing capability)
3. `skills.run(name, args)` looks up skill, executes its implementation in current sandbox worker
4. `skills.findByQuery(query)` uses vector index over (skill.name + skill.description + skill.tags)

**Behavior — `findTool`:**

1. At registry refresh, embed each tool's `${name}\n${description}` via local model (ONNX, MiniLM-L6 ~22MB) or remote (Anthropic API)
2. Store in in-memory vector index (`hnswlib-node` or simple cosine over Float32Array — start simple)
3. Query: embed query, return top-K by cosine similarity
4. Optional: LanceDB backend over Tailscale to Mac Mini 01 (`100.120.54.53`) — use if `$LANCEDB_URL` set
5. Re-embed on registry hot reload

**Configuration:**

```json
{
  "skills": {
    "skillsDir": "$CLAUDE_SKILLS_DARKICE",
    "watchEnabled": true
  },
  "findTool": {
    "embeddingModel": "local",  // 'local' | 'anthropic' | 'lancedb'
    "lancedbUrl": "http://100.120.54.53:8000",
    "topK": 5
  }
}
```

**Acceptance criteria:**

- [ ] `mcp.compact` field selection produces correct subset; arrays truncate at `maxItems`
- [ ] `mcp.summarize` output ≤ `maxTokens`
- [ ] `mcp.budget` auto-trims; throws if untrimmable
- [ ] `mcp.delta` returns smaller payload than full for incremental updates
- [ ] `mcp.findTool('list github issues')` returns `github.list_issues` in top 3
- [ ] `skills.run` executes a skill from `$CLAUDE_SKILLS_DARKICE`
- [ ] `skills.findByQuery` returns relevant skills
- [ ] All sandbox helpers are zero-roundtrip (no out-of-process calls)

**Test cases:**

```typescript
// compact.test.ts
test('field selection retains specified fields');
test('field selection drops others');
test('dot-path field selection works');
test('maxItems truncates arrays');
test('maxStringLength truncates long strings');
test('maxDepth limits nesting');

// summarize.test.ts
test('respects maxTokens for arrays');
test('respects maxTokens for objects');
test('list/paragraph/json styles produce expected shapes');

// delta.test.ts
test('returns DeltaResult identical to cache.delta');

// budget.test.ts
test('auto-trims oversized result');
test('throws BudgetExceededError when untrimmable');

// findtool.test.ts
test('relevant tool ranks in top 3 for typical query');
test('serverFilter restricts results');
test('re-embeds on registry update');

// skills.test.ts (extends existing)
test('loads from $CLAUDE_SKILLS_DARKICE when set');
test('skills.run executes skill implementation');
test('skills.findByQuery returns relevant skills');
test('hot reload picks up new skill within 1s');
```

---

### Phase 6 — Daemon Mode & Multi-Agent Coordination (Day 6, ~6 hours)

**Goal:** promote conductor to a Tailscale-discoverable daemon shared by multiple Claude Code agents.

**Files to create:**

```
src/daemon/
├── index.ts              # daemon entry point
├── server.ts             # Unix socket / TCP server
├── client.ts             # thin agent-side bridge
├── discovery.ts          # Tailscale peer discovery
├── shared-kv.ts          # shared key-value store
├── shared-lock.ts        # distributed locks (single-host for v3, real distributed in v3.1)
└── tests/

src/cli/
└── daemon.ts             # NEW commands: start/stop/status
```

**Public API:**

```typescript
// Daemon-side
export class DaemonServer {
  constructor(options: {
    socketPath?: string;       // default ~/.mcp-conductor/daemon.sock
    tcpPort?: number;          // optional, for Tailscale
    tailscaleHostname?: string;
    auth: { sharedSecret: string };
  });

  start(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): DaemonStats;
}

// Agent-side bridge (acts as drop-in for direct execution mode)
export class DaemonClient {
  constructor(options: { socketPath?: string; tailscaleAddress?: string; auth: { sharedSecret: string } });

  connect(): Promise<void>;
  callTool(name: string, args: unknown): Promise<unknown>;
  disconnect(): Promise<void>;
}

// Inside execute_code — new sandbox API:
mcp.shared.kv.get<T>(key: string): Promise<T | null>;
mcp.shared.kv.set<T>(key: string, value: T, options?: { ttl?: number }): Promise<void>;
mcp.shared.kv.delete(key: string): Promise<void>;
mcp.shared.kv.list(prefix?: string): Promise<string[]>;

mcp.shared.lock(key: string, options?: { timeoutMs?: number }): Promise<{ release: () => Promise<void> }>;
mcp.shared.broadcast(channel: string, message: unknown): Promise<void>;
mcp.shared.subscribe(channel: string, handler: (msg: unknown) => void): Promise<{ unsubscribe: () => void }>;
```

**Behavior:**

1. `mcp-conductor-cli daemon start` starts daemon process with Unix socket + optional TCP
2. CLI agents connect via stdio bridge → daemon (transparent to Claude/CC)
3. Daemon shares: registry, cache, reliability stats, sandbox pool, shared KV
4. Auth: shared secret in `~/.mcp-conductor/daemon-auth.json` (mode 0600)
5. KV: in-memory + disk-persistent (`~/.mcp-conductor/kv/`); TTL supported
6. Locks: in-process mutex per key (sufficient for single-daemon; real distributed locks deferred)
7. Broadcast/subscribe: in-process pub/sub for now; cross-daemon in v3.1

**Migration:**

- v2 mode (one conductor per agent) remains the default
- Set `"daemon.enabled": true` in `~/.mcp-conductor.json` to switch agents to daemon mode
- CLI commands:
  - `mcp-conductor-cli daemon start` (background)
  - `mcp-conductor-cli daemon stop`
  - `mcp-conductor-cli daemon status`
  - `mcp-conductor-cli daemon logs`

**Configuration:**

```json
{
  "daemon": {
    "enabled": false,
    "socketPath": "~/.mcp-conductor/daemon.sock",
    "tcpPort": 9876,
    "tailscaleHostname": "darkice-daemon",
    "auth": {
      "sharedSecretPath": "~/.mcp-conductor/daemon-auth.json"
    }
  }
}
```

**Acceptance criteria:**

- [ ] Two agents connected to same daemon share cache (verified: agent B's call hits cache populated by agent A)
- [ ] Lock primitive serializes concurrent writers (verified by 100-concurrent test)
- [ ] KV TTL expiry works
- [ ] Daemon survives one agent crashing (other agents unaffected)
- [ ] Tailscale peer discovery finds daemon by hostname
- [ ] Auth rejects unauthenticated connections

**Test cases:**

```typescript
// daemon-server.test.ts
test('starts and accepts connections');
test('shutdown drains in-flight requests');
test('rejects unauthenticated connection');
test('survives client crash');

// daemon-client.test.ts
test('connect over Unix socket');
test('connect over TCP');
test('callTool roundtrips correctly');

// shared-kv.test.ts
test('set then get from same client');
test('cross-client read after write');
test('TTL expiry');
test('list with prefix');
test('disk persistence');

// shared-lock.test.ts
test('mutual exclusion under concurrent acquire');
test('release allows next acquirer');
test('timeout returns null/throws');
test('100 concurrent: serial execution');

// integration
test('two-agent cache sharing scenario');
test('two-agent lock contention scenario');
```

---

### Phase 7 — Observability & Replay (Day 7, ~5 hours)

**Goal:** cost predictor, hot-path profiler, deterministic replay.

**Files to create:**

```
src/observability/
├── index.ts
├── cost-predictor.ts     # estimates token cost from call history
├── hot-path.ts           # latency / call-volume profiler
├── anomaly.ts            # outlier detection
├── replay.ts             # record + replay execute_code calls
└── tests/

src/cli/
└── replay.ts             # CLI for replay
```

**Public API:**

```typescript
// MCP tools (additions to the 11 existing):
predict_cost(args: { code: string }): Promise<{
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedLatencyMs: number;
  basedOn: number;  // sample size
}>;

get_hot_paths(args: { sinceMs?: number; topK?: number }): Promise<Array<{
  server: string;
  tool: string;
  callCount: number;
  totalLatencyMs: number;
  meanLatencyMs: number;
  p99LatencyMs: number;
}>>;

record_session(args: { sessionId?: string }): Promise<{ sessionId: string; recordingPath: string }>;
stop_recording(args: { sessionId: string }): Promise<{ recordingPath: string; eventCount: number }>;
replay_session(args: {
  recordingPath: string;
  modifications?: Array<{ at: number; op: 'replace' | 'skip'; with?: unknown }>;
}): Promise<{ result: unknown; divergence?: { at: number; expected: unknown; actual: unknown } }>;
```

**Behavior:**

1. **Cost predictor:** Maintains rolling history per `(tool, args-shape-fingerprint)`. Args shape = JSON schema of args (types only, not values). Predicts output tokens from past similar calls
2. **Hot path:** Wrap every backend call in latency tracker; aggregate per `(server, tool)`. Surfaces top-K by total time and by p99
3. **Anomaly:** For each `(server, tool)`, track distribution of result sizes / latencies. Flag calls >3σ from mean. Surface in `get_metrics`
4. **Replay:** `record_session` enables event journaling: every `execute_code` call's input + intermediate tool calls + result captured to `.jsonl`. `replay_session` re-executes the captured TS code in a fresh sandbox; backend calls return recorded results unless modified. Detects divergence (recorded result ≠ replayed result)

**Configuration:**

```json
{
  "observability": {
    "costPredictor": { "enabled": true, "minSamplesForPrediction": 5 },
    "hotPath": { "enabled": true, "windowMs": 3600000 },
    "anomaly": { "enabled": true, "stdDevThreshold": 3 },
    "replay": { "recordingsDir": "~/.mcp-conductor/recordings" }
  }
}
```

**Acceptance criteria:**

- [ ] Cost predictor within 30% of actual on benchmark suite (after 10+ samples)
- [ ] Hot path returns deterministic ordering (same data → same ranking)
- [ ] Anomaly detector catches synthetic 10× outlier
- [ ] Replay reproduces recorded session bit-identical when no modifications
- [ ] Replay with `op: 'skip'` modification correctly bypasses one call
- [ ] Recordings rotate at 1GB total

**Test cases:**

```typescript
// cost-predictor.test.ts
test('returns null prediction below minSamples');
test('prediction within 30% of actual on benchmark');
test('args-shape fingerprint stable for same shape');

// hot-path.test.ts
test('top-K by total latency correct');
test('top-K by p99 correct');
test('window expiry drops old samples');

// anomaly.test.ts
test('flags 10x outlier');
test('does not flag within 1σ');

// replay.test.ts
test('record produces well-formed jsonl');
test('replay no-mod reproduces result');
test('replay with skip bypasses call');
test('replay detects divergence');
test('rotation at maxBytes');
```

---

## 6. Cross-cutting concerns

### 6.1 Configuration migration

v2 `~/.mcp-conductor.json` is fully backwards-compatible. New top-level keys (`registry`, `cache`, `reliability`, `runtime`, `skills`, `findTool`, `daemon`, `observability`) are optional with sane defaults. Document migration path in `docs/v3/migration.md`.

### 6.2 Backwards compatibility

All 11 existing MCP tools (execute_code, list_servers, discover_tools, get_metrics, set_mode, compare_modes, add_server, remove_server, update_server, reload_servers, passthrough_call) keep their current signatures. New tools (`predict_cost`, `get_hot_paths`, `record_session`, `stop_recording`, `replay_session`) are additions.

Sandbox API additions (`mcp.compact`, `mcp.summarize`, `mcp.delta`, `mcp.findTool`, `mcp.budget`, `mcp.shared.*`, `skills.*`) are non-breaking.

### 6.3 Testing strategy

- Maintain 673 existing tests passing
- Each phase ships with its own test files; minimum 25 new tests per phase
- New benchmark suite: `npm run benchmark:v3` covers token reduction, latency, cache hit rate
- Integration tests: end-to-end through real Deno sandbox with mock backends
- Coverage target ≥85% (up from 82%)

### 6.4 Documentation

- `docs/v3/architecture.md` — diagrams and component overview
- `docs/v3/migration.md` — v2 → v3 migration
- `docs/v3/configuration.md` — full config reference
- `docs/v3/sandbox-api.md` — updated `mcp` API including helpers, skills, shared
- `docs/v3/recipes.md` — example execute_code workflows showcasing v3 features
- README updated per phase

### 6.5 Observability of the implementation itself

Use `record_session` (Phase 7) to capture canonical demo workflows for regression testing. Each phase adds at least one canonical recording.

## 7. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Type generation breaks on edge-case schemas (recursive, oneOf) | Medium | Medium | `json-schema-to-typescript` is mature; fallback to `unknown` for failed conversions; never crash refresh on bad schema |
| Cache invalidation correctness (esp. file mtime) | Medium | High | Conservative defaults (short TTL, no caching of mutations); explicit invalidation API; integration tests with real filesystem |
| Worker pool memory growth | Low | High | Recycle policy (maxJobsPerWorker, maxAgeMs); 1000-job memory test in CI |
| Daemon mode complicates ops | High | Medium | Opt-in only; clear CLI; `daemon status` shows everything |
| Reliability gateway false positives (premature circuit trip) | Medium | Medium | `minCalls` threshold; tunable per server; clear `resetCircuit` API |
| Skills wiring breaks if skills dir malformed | Medium | Low | Existing engine handles errors gracefully; surface bad skills in logs |
| Vector index latency at startup with many tools | Low | Medium | Lazy initialize (build on first findTool call); cache embeddings to disk |

## 8. Open questions

1. **TTL defaults per tool category** — start with the table in §Phase 2; iterate based on real usage
2. **Storage location** — settle on `~/.mcp-conductor/` for everything; document in §Configuration
3. **Daemon authentication mechanism** — start with shared secret file (mode 0600); upgrade to OS keychain in v3.1
4. **Embedding model for findTool** — start with local MiniLM-L6 ONNX; switch to Anthropic API if local quality insufficient
5. **Cross-daemon coordination (Tailscale mesh)** — defer to v3.1; v3 single-daemon is fine for current 6–8 agents

## 9. Suggested CC agent layout (for parallel execution)

The phases have dependencies but Phase 2 onward can run in parallel after Phase 1 lands. Suggested 6-agent split:

- **Agent A (lead):** Phase 0 → Phase 1 → final integration
- **Agent B:** Phase 2 (cache) — starts after Phase 1 registry exists
- **Agent C:** Phase 3 (reliability) — independent, can start after Phase 0
- **Agent D:** Phase 4 (pools) — coordinate with Agent B/C for integration points
- **Agent E:** Phase 5 (sandbox capabilities) — depends on Phase 1 + 4
- **Agent F:** Phase 6 (daemon) — depends on Phase 1; can build in parallel
- **Agent G (optional):** Phase 7 (observability) — independent

Final integration day: Agent A merges, runs full benchmark suite, validates v3 success metrics.

## 10. Definition of done

- [ ] All 7 phases' acceptance criteria met
- [ ] All 673 existing tests pass + ≥175 new tests added
- [ ] Coverage ≥85%
- [ ] Benchmark suite shows ≥96% token reduction (cache miss), ≥99% (cache hit)
- [ ] Median execute_code latency: ≤30ms cold, ≤10ms warm
- [ ] No hangs in 1-hour soak test against fault-injected backends
- [ ] Two-agent daemon scenario shows ≥40% cache sharing
- [ ] `docs/v3/` complete
- [ ] README updated
- [ ] Tagged `v3.0.0-beta.1` and published to npm under `next` dist-tag
- [ ] Demo recording (via Phase 7 replay) committed to repo

---

## Appendix A — File structure delta (final v3 layout)

```
src/
├── bridge/
│   ├── (existing files)
│   └── pool.ts                  # NEW
├── cache/                       # NEW directory
│   ├── index.ts
│   ├── lru.ts
│   ├── disk.ts
│   ├── key.ts
│   ├── delta.ts
│   ├── policy.ts
│   ├── cache.ts
│   └── tests/
├── config/                      # existing
├── daemon/                      # NEW directory
│   ├── index.ts
│   ├── server.ts
│   ├── client.ts
│   ├── discovery.ts
│   ├── shared-kv.ts
│   ├── shared-lock.ts
│   └── tests/
├── hub/                         # existing
├── index.ts                     # MODIFIED — wire up registry, cache, reliability, daemon
├── metrics/                     # existing
├── modes/                       # existing
├── observability/               # NEW directory
│   ├── index.ts
│   ├── cost-predictor.ts
│   ├── hot-path.ts
│   ├── anomaly.ts
│   ├── replay.ts
│   └── tests/
├── registry/                    # NEW directory
│   ├── index.ts
│   ├── registry.ts
│   ├── typegen.ts
│   ├── validator.ts
│   ├── snapshot.ts
│   ├── events.ts
│   ├── types/                   # generated, gitignored
│   └── tests/
├── reliability/                 # NEW directory
│   ├── index.ts
│   ├── profile.ts
│   ├── breaker.ts
│   ├── retry.ts
│   ├── timeout.ts
│   ├── gateway.ts
│   └── tests/
├── runtime/
│   ├── (existing files)
│   ├── pool/                    # NEW
│   │   ├── index.ts
│   │   ├── worker-pool.ts
│   │   ├── worker.ts
│   │   ├── recycle.ts
│   │   └── tests/
│   ├── helpers/                 # NEW
│   │   ├── index.ts
│   │   ├── compact.ts
│   │   ├── summarize.ts
│   │   ├── delta.ts
│   │   ├── budget.ts
│   │   └── tests/
│   └── findtool/                # NEW
│       ├── index.ts
│       ├── vector-index.ts
│       ├── embed.ts
│       └── tests/
├── server/                      # existing
├── skills/                      # MODIFIED — load from CLAUDE_SKILLS_DARKICE
├── streaming/                   # existing
├── utils/                       # existing
├── version.ts                   # bump to 3.0.0-beta.1
└── watcher/                     # existing
```

## Appendix B — Single-line CC kickoff commands

```bash
# Initial setup
cd /Users/mattcrombie/Dev/Projects/Claude/mcp-executor-darkice
git checkout -b feature/v3
cp /path/to/this/PRD.md _plans/v3/PRD.md

# Then for each agent in a separate Claude Code session:
# Agent A:
"Read _plans/v3/PRD.md and implement Phase 0 then Phase 1 (Tool Registry & Type Generation). Stop after Phase 1 acceptance criteria are met. Run npm run test:run between Phase 0 and Phase 1."

# Agent B (after Phase 1 lands):
"Read _plans/v3/PRD.md and implement Phase 2 (Cache Layer). The Tool Registry from Phase 1 is available in src/registry/. Run npm run test:run when complete."

# Agent C (after Phase 0):
"Read _plans/v3/PRD.md and implement Phase 3 (Reliability Gateway). Independent of registry; integrate with bridge layer. Run npm run test:run when complete."

# ... and so on
```

## Appendix C — Daily checkpoint format

Each day's CC session ends with a status comment in `_plans/v3/STATUS.md`:

```markdown
## Day N — YYYY-MM-DD

**Phase:** [phase number and name]
**Status:** [in progress / complete / blocked]
**Tests:** [count passing / total]
**Coverage:** [%]
**Acceptance criteria met:** [n/total]
**Notes:** [any deviations from PRD, decisions made]
**Next:** [next phase or task]
```

---

*End of PRD.*
