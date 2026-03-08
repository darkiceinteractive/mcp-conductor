# Developer Recommendations

Compiled findings from five independent code review agents run against the MCP Conductor codebase. Organised by severity with actionable recommendations.

---

## Critical

### 1. Template Injection in Sandbox Code Generation
**Source:** Security Review
**File:** `src/runtime/executor.ts`

The `generateSandboxCode()` function interpolates user code directly into a template string. Crafted input containing the result delimiter or template escapes could break out of the sandbox wrapper.

**Recommendation:** Use a file-based approach — write user code to a separate file and import it, rather than string interpolation.

### 2. Batch Error Handling Swallows Failures
**Source:** Quality Review
**File:** `src/server/mcp-server.ts`

`mcp.batch()` uses `Promise.all` semantics but the documentation suggests partial failure tolerance. If one call fails, the entire batch rejects, potentially losing successful results.

**Recommendation:** Document the `Promise.all` semantics clearly. Consider offering a `batchSettled()` variant that uses `Promise.allSettled`.

### 3. JSON.parse Without Size Limit
**Source:** Quality Review
**File:** `src/bridge/http-server.ts`

The bridge parses incoming request bodies without enforcing a maximum size. A malicious or buggy sandbox could send arbitrarily large payloads.

**Recommendation:** Add a body size limit (e.g., 10 MB) to the bridge HTTP server.

---

## High

### 4. Environment Variable Leak to Deno Subprocess
**Source:** Security Review
**File:** `src/runtime/executor.ts`

The Deno subprocess may inherit parent process environment variables unless explicitly cleared. Sensitive variables (API keys, tokens) could be accessible.

**Recommendation:** Pass `env: {}` (empty) or an explicit allowlist when spawning the Deno subprocess.

### 5. No Bridge Authentication
**Source:** Security Review
**File:** `src/bridge/http-server.ts`

The bridge has no authentication mechanism. While it binds to localhost, any local process can send requests.

**Recommendation:** Add a per-execution shared secret (generated at spawn time, passed to the sandbox via Deno args) that the bridge validates on each request.

### 6. `checkDeno()` Spawns Subprocess Every Execution
**Source:** Performance Review
**File:** `src/runtime/executor.ts`

`checkDeno()` runs `deno --version` before every execution to verify Deno is installed. This adds ~50ms latency per call.

**Recommendation:** Cache the result after the first successful check. Invalidate only on error.

### 7. Synchronous `readFileSync` on Hot Path
**Source:** Performance Review
**File:** `src/config/`

Config loading uses `readFileSync`, which blocks the event loop. Under load with frequent hot-reloads, this creates a bottleneck.

**Recommendation:** Use async `readFile` for config loading, especially in the watcher path.

### 8. Unbounded String Concatenation in stdout Buffering
**Source:** Performance Review
**File:** `src/runtime/executor.ts`

Sandbox stdout is collected via string concatenation. For large outputs, this creates O(n²) memory allocation.

**Recommendation:** Use an array buffer and join once, or use `Buffer.concat()`.

### 9. `connecting` Status Not in `list_servers` Schema
**Source:** API Review
**File:** `src/server/mcp-server.ts`

The `list_servers` tool schema defines status as `connected | disconnected | error`, but the hub can report `connecting` during startup.

**Recommendation:** Add `connecting` to the schema enum and document it.

### 10. `structuredContent` Missing on Error Paths
**Source:** API Review
**File:** `src/server/mcp-server.ts`

Some error responses set `isError: true` but omit the `structuredContent` field, making programmatic error handling inconsistent.

**Recommendation:** Ensure all error responses include both `isError` and a structured error object with `type` and `message`.

### 11. Server Module Coverage at 75.9%
**Source:** Test Strategy Review
**File:** `src/server/`

The main server module — the most complex component — has below-target coverage. Key gaps include error recovery paths and mode switching edge cases.

**Recommendation:** Add tests for: server startup failures, mode switching during execution, concurrent tool registrations, and error serialisation paths.

### 12. Runtime Module Silent Deno Skips
**Source:** Test Strategy Review
**File:** `test/`

Runtime tests silently skip when Deno is not installed (`describe.skip`), hiding 40+ tests from CI results. Coverage appears higher than it actually is.

**Recommendation:** Make Deno a CI requirement. If skipping, emit a visible warning in test output rather than silently skipping.

---

## Medium

### 13. Rate Limiter 50ms Poll Interval
**Source:** Performance Review
**File:** `src/hub/`

The queue-mode rate limiter polls every 50ms for token availability. Under high concurrency this wastes CPU.

**Recommendation:** Use an event-driven approach — resolve waiting promises when tokens are refilled rather than polling.

### 14. Hardcoded Version `0.1.0`
**Source:** API Review
**File:** `src/server/mcp-server.ts`

The MCP server reports version `0.1.0` in `get_capabilities`, but `package.json` is at `1.0.1`.

**Recommendation:** Read version from `package.json` at build time or import from a generated version file.

### 15. Config Change Detection Uses JSON.stringify Comparison
**Source:** Performance Review
**File:** `src/watcher/`

The file watcher detects changes by comparing `JSON.stringify(oldConfig) === JSON.stringify(newConfig)`. This is O(n) on config size and sensitive to key ordering.

**Recommendation:** Use a deep-equal utility or hash comparison instead.

### 16. Double Scan in `getSessionMetrics`
**Source:** Performance Review
**File:** `src/metrics/metrics-collector.ts`

`getSessionMetrics()` iterates the execution history twice — once for aggregation, once for min/max. Can be done in a single pass.

**Recommendation:** Combine into a single reduce pass.

### 17. `compare_modes` Uses Different Constants Than MetricsCollector
**Source:** API Review
**File:** `src/server/mcp-server.ts`

The `compare_modes` tool has inline estimation constants that differ from those in `MetricsCollector`, leading to inconsistent results.

**Recommendation:** Extract constants to a shared location. Import from `MetricsCollector` or a shared config.

### 18. `brave_web_search` Registered Unconditionally
**Source:** API Review
**File:** `src/server/mcp-server.ts`

The `batchSearch` convenience method assumes a `brave-search` server exists. If it doesn't, calls fail at runtime rather than at registration.

**Recommendation:** Only register `batchSearch` when a brave-search server is actually configured.

### 19. Integration Tests Don't Test Actual Rate Limiting
**Source:** Test Strategy Review
**File:** `test/integration/`

Rate-limiting integration tests mock the limiter rather than testing real timing behaviour. Edge cases like token refill races are untested.

**Recommendation:** Add time-based integration tests using `vi.useFakeTimers()` to verify actual rate limiting behaviour.

### 20. Flaky `setTimeout`-Based Tests
**Source:** Test Strategy Review
**File:** `test/`

Several tests rely on `setTimeout` with hardcoded delays, creating race conditions in CI environments.

**Recommendation:** Replace with `vi.useFakeTimers()` or event-driven assertions.

---

## Low

### 21. `mcp-server.ts` Is a God Object (1,700+ lines)
**Source:** Quality Review, Performance Review

The main server file handles tool registration, mode routing, metrics, streaming, and error handling in a single file.

**Recommendation:** Extract into focused modules: `tool-handlers.ts`, `mode-router.ts`, `response-formatter.ts`. This improves testability and reduces cognitive load.

### 22. Require() in ESM Context
**Source:** Quality Review

Some code paths use `require()` for dynamic imports in what should be an ESM-only codebase.

**Recommendation:** Replace with dynamic `import()` for consistency.

### 23. `update_server` Inconsistent Field Format
**Source:** API Review

`add_server` accepts `config: { command, args, env }` but `update_server` accepts `command`, `args`, `env` as top-level fields. Inconsistent API surface.

**Recommendation:** Accept both formats in `update_server` for backward compatibility, or document the difference clearly.

### 24. Benchmark Tests Conflate Marketing with Correctness
**Source:** Test Strategy Review

Some benchmark assertions read like marketing claims ("95% savings!") rather than engineering validations. Floor thresholds (≥ 85%) are more appropriate than exact targets.

**Recommendation:** Frame benchmarks as regression tests with floor thresholds. Keep exact numbers in documentation, not assertions.

---

## Summary by Category

| Category | Critical | High | Medium | Low |
|----------|----------|------|--------|-----|
| Security | 1 | 2 | — | — |
| Quality | 2 | — | — | 2 |
| Performance | — | 3 | 3 | 1 |
| API | — | 2 | 3 | 1 |
| Testing | — | 2 | 2 | 1 |
| **Total** | **3** | **9** | **8** | **5** |

## Recommended Priority

1. **Immediate** (before public release): Items 1–3 (critical security and reliability)
2. **High priority** (first sprint after release): Items 4–12 (security hardening, performance, API consistency)
3. **Planned** (subsequent releases): Items 13–24 (optimisations, refactoring, test improvements)
