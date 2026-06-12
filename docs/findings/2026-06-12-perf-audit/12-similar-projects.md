# 12 — Similar Projects: Competitive Landscape & Steal-Worthy Patterns

Captured: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5`

---

## Overview

This document surveys ten projects in the MCP orchestrator / AI-proxy / tool-routing space, with the explicit goal of identifying architectural patterns mcp-conductor should adopt or adapt. For each project the analysis covers: (a) what it does, (b) the specific patterns that are interesting, and (c) how it compares to our approach. Five specific recommendations follow the survey.

---

## 1. FastMCP (jlowin/fastmcp) — Python, 25k stars

### What it does

FastMCP is the canonical way to build MCP servers in Python. Version 1.0 was incorporated into the official MCP Python SDK in 2024; the project is now independently maintained and claims to power 70% of all MCP servers across all languages. FastMCP 3.0 (released 2026) reorganises the entire framework around three fundamental primitives: **Components** (atomic tools/resources/prompts), **Providers** (where components come from — decorators, filesystems, remote servers, OpenAPI specs), and **Transforms** (middleware that shapes provider output without touching source code). The latest stable release is 3.4.2 (June 2026).

### Interesting patterns

**Providers + Transforms decoupling.** Providers source components; Transforms reshape them. Namespace prefixing, tool renaming, visibility filtering, and auth-gating are all Transforms — they are independent of the underlying Component logic. Sub-server mounting is just a Provider backed by a remote FastMCP client, plus a namespace Transform. This means any composition feature — proxy, aggregation, filtering — falls out of the same three-primitive model rather than requiring bespoke glue code.

**Session-aware progressive disclosure.** Because Transforms can see session state, a FastMCP 3 server can expose different tool sets to different sessions — hiding tools from an unauthed session, revealing admin tools to an elevated session, etc. This is built in, not bolted on.

**Sync-tool threadpool dispatch.** Synchronous tools are automatically dispatched to a threadpool, preventing a slow blocking call from stalling the asyncio event loop. This is a correctness fix that most conductors skip.

**Context crowding addressed architecturally.** FastMCP 3 explicitly names "context crowding" (500 tools in context) as a first-class problem and addresses it through selective tool disclosure via Transforms rather than relying on the consumer to do lazy loading. The framework controls what appears in the tool list per-session.

**Hot reload.** File-watching hot reload is built in, allowing live code changes without kill-restart cycles — relevant for local development of backend MCP servers.

### Versus mcp-conductor

FastMCP is a server-building framework, not an orchestrator. It does not aggregate *other* servers; it is what those other servers are built with. Our `passthrough-registrar.ts` does what Providers do, and our mode system does what Transforms do, but our abstractions are less composable: modes are global switches, not per-session layered transforms. The Provider/Transform decomposition is cleaner and worth stealing for the mcp-conductor internals. Where we are ahead: FastMCP has no token-compression pipeline, no LRU/CBOR cache, no delta encoding, and no multi-server aggregation — those are purely our differentiation.

---

## 2. mcp-proxy (sparfenyuk/mcp-proxy) — Python CLI bridge

### What it does

mcp-proxy is a two-mode transport bridge written in Python. Mode 1: convert SSE/StreamableHTTP servers to stdio so that Claude Desktop (which only speaks stdio natively) can reach remote servers. Mode 2: expose a local stdio server over SSE so remote clients can connect to it. Version 0.8.0 introduced multi-server mode: a single proxy instance can host multiple named backend servers, each accessible at `/servers/<name>/sse`. Backend configuration uses the same `mcpServers` JSON format as Claude Desktop configs, allowing copy-paste reuse.

### Interesting patterns

**Named-server routing at the HTTP path layer.** Each server gets a dedicated URL path (`/servers/fetch/sse`, `/servers/memory/sse`). This means a single proxy process — one port — demultiplexes connections to any number of backends. The routing key is the URL path, not a header or body field. This is simpler and more debuggable than header-based routing.

**`/status` global health endpoint.** A single HTTP GET returns the health of all mounted servers. This is a one-line implementation but makes the proxy immediately observable without any extra tooling.

**Stateless mode for Streamable HTTP.** The `--stateless` flag disables server-side session tracking, enabling horizontal scaling of the proxy tier. Sessions are driven entirely by the client. This is relevant when mcp-conductor is deployed as a multi-instance service rather than a single local process.

**Config file format reuse.** Using the same `mcpServers` JSON schema as Claude Desktop means zero migration friction — users paste their existing config and the proxy just works. Our `.mcp-conductor.json` format is similar but diverges in server-capability annotations. A migration script or format shim would reduce onboarding friction.

### Versus mcp-conductor

mcp-proxy does transport bridging only. It has no tool compression, no token budget management, no semantic search, no caching, no compare mode, no circuit breakers, and no meta-tools. Our value proposition is entirely in layers above what mcp-proxy does. Where mcp-proxy is ahead: the URL-path routing pattern is cleaner than our current single-endpoint model, and the stateless mode is something our HTTP bridge layer should offer.

---

## 3. Smithery.ai — Registry and managed hosting, 7,300+ servers

### What it does

Smithery is a registry-and-distribution platform for MCP servers. It hosts over 7,300 servers (as of May 2026), operates a CLI (`@smithery/cli`) for search/add/remove, supports two deployment models (local and hosted remote), and provides managed OAuth through `agent.pw`. It is best described as Docker Hub + Homebrew for MCP servers. Individual server configs are added to Claude Code or Claude Desktop via `smithery add <server-name>`. The platform has a separate Skills registry alongside the main MCP server registry.

### Interesting patterns

**Two-tier discovery: registry search + skills.** Smithery separates server discovery (package registry) from skill discovery (prompt/workflow templates). This aligns with the emerging separation of *tools* (MCP) and *instructions* (skills) that Anthropic's own Claude Code uses. Having distinct registries for distinct concepts avoids the "everything is a tool" conflation.

**Hosted MCP with ephemeral token handling.** In hosted mode, API keys are passed ephemerally and not stored. This is a security-forward choice that reduces the blast radius of a key leak — the key is live only during the active request, never written to disk.

**Namespace management for team environments.** The CLI's namespace commands (`list namespaces`, `set namespace`) suggest a multi-tenant org model where different teams own different server sets. This is exactly the isolation that enterprise deployments need and which our current config schema does not model.

**Pre-configured bundles.** Smithery can install multiple related servers in one step via bundle manifests. Our wizard already does something similar with the setup flow, but a bundle format would let power users share complete configurations as a single artefact.

### Versus mcp-conductor

Smithery and mcp-conductor are complementary rather than competing. Smithery answers "how do I find and install a server?"; mcp-conductor answers "how do I orchestrate the servers I have?". The gap we have: no equivalent of Smithery's registry integration. We advertise 498 backend tools via the catalog, but no mechanism lets users *discover new servers to add* from inside the conductor. A `conductor://registry` resource or `search_registry` meta-tool that queries the Smithery API would close this gap and expose our user base to the broader ecosystem.

---

## 4. IBM ContextForge — Enterprise MCP gateway, Python + Redis

### What it does

ContextForge is IBM's open-source AI gateway that federates MCP, A2A, REST, and gRPC endpoints behind a single unified MCP interface. It translates gRPC services to MCP tools via automatic reflection-based service discovery, wraps REST endpoints as virtual MCP servers, federates across multiple gateway instances using mDNS/Redis, and provides an admin UI, OpenTelemetry tracing, and 40+ plugins. Version 1.0.0-BETA-1 released December 2025 added multi-architecture containers, Redis-backed federation caching, and Kubernetes Helm charts.

### Interesting patterns

**Protocol bridging: REST and gRPC as virtual MCP servers.** Any REST or gRPC API can become a first-class MCP tool without any code changes to the underlying service. ContextForge generates JSON Schema from the OpenAPI/protobuf definition and handles the impedance mismatch automatically. This is significant for enterprises with large existing API surface areas.

**mDNS federation.** Multiple ContextForge instances auto-discover each other and share tool registries. A tool registered on instance A is callable from instance B without manual cross-registration. This is a fundamentally different scaling model to our single-instance conductor: instead of one conductor knowing about all servers, the knowledge is distributed and eventually consistent.

**TOON compression.** ContextForge uses its own "TOON compression" for agent/tool calling efficiency — described as optimising the wire format of tool calls. Specific compression ratios are not published, but the intent is the same as our token-compression pipeline.

**A2A protocol support alongside MCP.** ContextForge routes traffic from OpenAI and Anthropic agents (A2A) alongside MCP clients through the same gateway. This positions it as a unified agent infrastructure layer rather than just an MCP proxy.

**Admin UI with real-time log viewing.** An HTMX-based dashboard provides live log streaming, tool search, and export. Our `diag_mode` meta-tool returns structured telemetry to the LLM, but there is no human-facing dashboard. For developers debugging multi-server setups, a lightweight local web UI would be high-value.

### Versus mcp-conductor

ContextForge targets large enterprise environments: Kubernetes, Redis, multi-cluster, gRPC. Its latency is higher than purpose-built gateways by design (federation consensus adds round-trips). mcp-conductor targets single-developer-to-small-team use cases with a focus on token budget at the LLM context layer. Where ContextForge is ahead: REST/gRPC bridging, federation, and the admin UI. Where we are ahead: token compression, LRU/CBOR caching, delta encoding, per-call telemetry, and PII tokenization — none of which ContextForge has.

---

## 5. Bifrost MCP Gateway — Code Mode, 92% token reduction

### What it does

Bifrost is a commercial MCP gateway that adds access control, cost governance, and audit logging on top of MCP aggregation. Its headline differentiator is **Code Mode**: instead of exposing 100–500 tool definitions directly in the LLM context, it surfaces exactly four generic meta-tools, and the LLM writes Python-like (Starlark) orchestration code that is executed in a sandboxed interpreter. Tool definitions are never injected into the prompt; the LLM reads compact `.pyi` stubs on demand. The benchmark result is 92.8% input token reduction at 508 tools across 16 servers ($3.20→$1.20 cost per task, 18–25 s → 8–12 s wall time). Bifrost adds 11 µs overhead per request at 5,000 RPS.

### Interesting patterns

**Code Mode / Starlark sandbox.** The four meta-tools are: `listToolFiles` (discover available tools as a virtual filesystem), `readToolFile` (load compact `.pyi` stub on demand), `getToolDocs` (retrieve full documentation for a specific tool), `executeToolCode` (run Starlark orchestration code). This keeps the full tool catalog entirely out of the prompt. The model only loads what it needs for the current task. Token cost grows logarithmically with tool count rather than linearly.

**Compact `.pyi` stubs instead of JSON Schema.** Rather than injecting a full `inputSchema` JSON blob, Bifrost exposes Python type-signature stubs. A function that would cost 200 tokens as JSON Schema costs ~20 tokens as a `.pyi` signature. The model reads the stub, understands the interface, and writes the call — no schema injection required.

**Virtual filesystem for tool organisation.** Tools are organised as `servers/youtube.pyi`, `servers/filesystem.pyi` etc. The LLM navigates a filesystem metaphor to discover tools, which maps well to how LLMs reason about file trees. This is a clever UX choice — LLMs are highly trained on filesystem navigation patterns.

**Per-client virtual keys with tool-level scoping.** Each API consumer gets a virtual key that carries a specific allow-list of tools. Scoping is at the individual tool level, not the server level. A client can be permitted `youtube.search` but not `youtube.delete_video`. This is finer-grained than our current per-server routing config.

**Mixed deployment: Code Mode and direct tools coexist.** Not all clients have to be in Code Mode. Some can receive direct tool definitions (for simple one-tool workflows), while others use Code Mode (for complex multi-server orchestration). The gateway decides based on the virtual key config.

### Versus mcp-conductor

Bifrost's Code Mode is the most directly threatening competitor pattern in this survey. Our current approach exposes meta-tools for discovery (`discover_tools`, `execute_code`) and keeps backend tools out of context — which is structurally similar. The key difference is the mechanism: we inject backend tools into an executor sandbox; Bifrost has the LLM *write code* that the sandbox runs. Bifrost's approach is more token-efficient because the LLM never sees the JSON Schema blob — it reads a compact stub. Our `execute_code` invocation currently requires the backend tool schema to be loaded into the LLM context before the call. Adopting compact `.pyi`-style stubs for our catalog entries would reduce our per-tool context footprint significantly. We are ahead on: caching (Bifrost has none), PII tokenization, delta encoding, and the full metrics/telemetry pipeline.

---

## 6. MetaMCP (metatool-ai) — Namespace-based aggregator with middleware

### What it does

MetaMCP is a Docker-based MCP aggregator with a web UI. It organises backend MCP servers into **namespaces** — a namespace groups one or more backend servers and exposes them as a single unified MCP endpoint. Middleware can be applied per-namespace to intercept and transform requests and responses. Tool descriptions, names, and annotations can be overridden per-namespace without touching the upstream server. MetaMCP pre-allocates idle sessions per server to reduce cold-start latency.

### Interesting patterns

**Tool description override layer.** MetaMCP's `namespace_tool_mappings` table lets operators override the display name, title, description, and annotations for any tool in a namespace. This is operationally significant: a generic tool description like "Executes a query" can be replaced with "Executes a read-only SQL query against the production analytics database — do not use for writes" without modifying the upstream server. Research (arXiv 2602.14878) shows that 97.1% of MCP tool descriptions contain quality defects ("smells"), with 56% failing to state their purpose clearly. Fixing descriptions at the gateway layer rather than at the source is the practical solution.

**Idle session pre-allocation.** MetaMCP maintains warm idle sessions per server instance, eliminating the cold-start latency that occurs when a tool is first called. This trades memory for latency — a reasonable trade for frequently-used servers. Our current model initialises connections on demand (with the lazy vs eager investigation in report 06).

**Per-namespace middleware pipeline.** Request/response transforms are applied as a composable middleware stack per namespace. This is the same idea as FastMCP's Transforms, but applied at the aggregator layer rather than the server-building layer. It enables: response trimming (cut verbose JSON before it reaches the LLM), PII scrubbing per-namespace, audit logging per-namespace, and rate limiting per-namespace.

**Multi-transport unified auth.** MetaMCP exposes SSE, Streamable HTTP, and OpenAPI endpoints behind a single auth layer. Clients connect once, get a token, and use it across all transport types.

### Versus mcp-conductor

Our architecture already has equivalents: passthrough-registrar for aggregation, PII tokenisation for scrubbing, rate-limiter for throttling. What we lack is the **tool description override layer** — a first-class way for operators to improve or annotate tool descriptions at the gateway layer. Given the research evidence that description quality directly affects agent task success rates, this is a high-value gap to close. We also lack idle-session pre-warming; our lazy-connect default (report 06) reduces initial memory cost but increases first-call latency.

---

## 7. Hyper-MCP (tuananh) — Rust, WASM plugin runtime

### What it does

Hyper-MCP is a Rust MCP server that executes tools as WebAssembly plugins via the Extism runtime. Plugins can be written in any WASM-compilable language (Go, Rust, C, AssemblyScript, etc.) and distributed as OCI container images, signed with Sigstore/Cosign. Each plugin runs in its own Extism VM with no filesystem or network access by default — permissions are declared explicitly in the plugin manifest and enforced at the WASM boundary. Startup latency per plugin is 1–10 ms. WASM overhead for compute-heavy operations is 5–15%; for I/O-bound operations it is negligible.

### Interesting patterns

**WASM as the sandboxing primitive.** Finer-grained than a subprocess (no process spawn cost), safer than a raw function call (memory isolation), and faster to start than a container (sub-10 ms vs 100–300 ms). The WASM model makes it practical to run third-party tool code with confidence that it cannot access the host system beyond declared permissions.

**OCI distribution with supply-chain signing.** Plugin images are pushed to standard container registries and signed at publish time. At load time, hyper-mcp verifies the signature against Sigstore's transparency log. This brings software supply chain security (SBOMs, provenance, tamper detection) to MCP tool plugins — a level of trust that spawning a `uvx` subprocess cannot provide.

**Declared-permission capability model.** Rather than granting all capabilities by default and restricting, the model inverts: tools start with zero access and declare what they need. A tool that needs network access to `api.example.com` declares that host; all other network calls fail at the WASM boundary. This is a capabilities-based security model and is significantly stronger than our current subprocess model.

**Language-agnostic plugin authoring.** Any language that compiles to WASM can produce a hyper-mcp plugin. The distribution model (OCI image) is universal. This lowers the barrier to creating new tools and enables a marketplace of signed, verified tool plugins.

### Versus mcp-conductor

mcp-conductor executes backend tools by spawning child processes (stdio MCP servers) or making HTTP calls. This gives us no isolation: a malicious or buggy backend tool can access the host filesystem, spawn its own processes, or leak memory into the parent. Hyper-MCP's WASM model is a meaningfully stronger security posture. We are not currently targeting the sandboxed-execution use case, but it is relevant if mcp-conductor ever exposes an "install and run untrusted tools" workflow (analogous to Smithery's hosted mode). The WASM approach is the right answer to that problem.

---

## 8. rust-mcp-sdk / prism-mcp-rs — Rust, sub-millisecond overhead

### What it does

Two Rust MCP implementations are worth tracking: `rust-mcp-sdk` (rust-mcp-stack) is a high-performance async toolkit for building MCP servers with Tokio, targeting sub-millisecond protocol overhead. `prism-mcp-rs` (prismworks-ai) is an enterprise-grade SDK adding circuit breaker patterns, adaptive retry with backoff, multi-level health checks, structured logging with correlation IDs, and OpenTelemetry tracing. Prism-mcp-rs publishes hard performance numbers: protocol overhead < 0.5 ms, automatic failover < 50 ms, zero-downtime deployment < 100 ms, memory baseline 2–12 MB. Connection multiplexing runs multiple logical MCP sessions over a single TCP connection.

### Interesting patterns

**< 0.5 ms protocol overhead target.** Our probe measured 10 468 ms cold-start, most of which is child-process initialisation rather than protocol overhead. But our per-call overhead is not currently measured separately from child execution time. Having a published sub-millisecond protocol overhead target is a useful engineering discipline — it forces separation of infrastructure latency from tool execution latency.

**Multi-level health checks.** Prism-mcp-rs implements health checks at three layers: transport (TCP reachability), protocol (can exchange MCP handshake), and resource (are the tool's dependencies available). Our `diagnose_server` meta-tool currently checks whether a server appears in the registry and whether its last call returned an error, but does not do a live protocol-layer health check against the running child process.

**Connection multiplexing.** Running multiple logical sessions over one TCP connection is the standard HTTP/2 pattern applied to MCP. Relevant for our bridge pool (`src/bridge/pool.ts`) and for any remote MCP server scenario where we might want to amortise connection setup cost.

**Adaptive retry with intelligent backoff.** Rather than fixed retry intervals, prism-mcp-rs adjusts retry timing based on observed failure patterns. This avoids the retry-amplification problem (identified in our own stress benchmarks) while maintaining resilience. Our current rate-limiter and gateway use fixed backoff.

### Versus mcp-conductor

Our runtime is Node.js/TypeScript, not Rust. We will not rewrite the core. But the patterns (multi-level health, multiplexing, adaptive retry, published latency SLOs) are language-independent and transferable. The Rust implementations set a performance ceiling we should be measuring ourselves against even if we cannot match their raw numbers.

---

## 9. Semantic Router (aurelio-labs) + LLM Tool Routers (LangChain/LlamaIndex)

### What it does

**Semantic Router** (aurelio-labs) routes requests by embedding the query and comparing it to pre-embedded "utterances" for each route using cosine similarity. It operates entirely in vector space — no LLM call required for routing decisions. Latency is typically 100 ms vs 5 000 ms for LLM-based routing. It scales to thousands of routes with in-memory storage or Pinecone/Qdrant backends.

**LlamaIndex Router** is a query-engine selection module that uses either LLM-based selectors (prompt-based text completion to pick a query engine) or Pydantic selectors (structured function-calling output). The `ToolRetrieverRouterQueryEngine` variant retrieves relevant tools from a large pool using embedding similarity before invoking the LLM, effectively doing a two-stage funnel: embed-retrieve → LLM-decide.

**LangChain tool routing** uses a similar two-stage model: semantic similarity first narrows the candidate set, then an agent reasons over the narrow set. The routing pattern also supports multi-routing (try multiple tools, combine results).

### Interesting patterns

**Two-stage funnel: embed-retrieve then LLM-decide.** The LLM should never see all N tools in context. First stage: embed the user query, cosine-search against tool embeddings, return top-k candidates (typically k ≤ 10). Second stage: LLM picks from the top-k with full schema loaded. This is strictly more efficient than either pure embedding routing (misses semantic nuance) or pure LLM routing over the full catalog (too expensive).

**Pre-embedded utterances vs live tool descriptions.** Semantic Router compares against *pre-embedded utterances* — curated examples of what a route handles — rather than against the raw tool description. This is more accurate than description-only embedding because tool descriptions are notoriously low-quality (per arXiv 2602.14878). Our `findTool` in `src/server/catalog.ts` uses BM25 keyword matching; the p99 at 10 000 tools is 359 ms (baseline report). Switching to pre-embedded cosine search would drop this to < 1 ms with in-memory ANN.

**No-LLM routing for the hot path.** Semantic Router's 100 ms routing is entirely computation, not API calls. For a conductor proxying high-frequency tool calls, LLM-free routing keeps the critical path off the rate-limited API and provides consistent low latency.

**Multi-routing with result combination.** When query intent is ambiguous across domains, multi-routing fans out to several tools in parallel and combines results. Our current `execute_code` is sequential (one tool at a time within a call). Parallel fan-out for multi-tool queries would reduce wall time on composite tasks.

### Versus mcp-conductor

Our `findTool` (BM25, src/server/catalog.ts) is keyword-based and not embedding-based. The p99 at 10 000 tools of 359 ms is too high for a call that should be sub-millisecond. Adopting embedding-based pre-indexing for the catalog would bring findTool p99 to < 5 ms at any scale while also improving recall on semantically-related queries ("list my positions" should match `get_pnl`, `get_positions`, not just tools whose description contains the exact word "list").

---

## 10. OpenAI Tool Search + Anthropic MCP Tool Search

### What it does

**OpenAI Tool Search** (gpt-5.4+) is a hosted mechanism where all tool definitions are declared upfront but only served to the model on demand. The model emits a search goal; OpenAI's servers retrieve relevant tool schemas; only retrieved schemas are injected at the end of the context window (preserving the KV cache for preceding turns). Best practice: group tools into namespaces of ≤ 10, with high-level namespace descriptions. A client-side mode also exists where the application controls what tools to return.

**Anthropic MCP Tool Search** was shipped in Claude Code (2026). Claude scans available MCP servers but only loads tool schemas when the active task requires them. The result is an 85% reduction in token usage with maintained tool access. Anthropic's own data: Opus 4 improved from 49% to 74% task success rate with Tool Search enabled, Opus 4.5 from 79.5% to 88.1%.

**Claude Skills vs MCP Tools.** Claude Code's Skills (`.claude/skills/*.md` files) do NOT yet have lazy loading — every installed skill's full description is injected into every session regardless of relevance. A feature request (GitHub issue #43816) exists for a `SkillSearch` equivalent. The architectural choice is: preload all skill metadata at startup (current) vs lazy-load skill body on demand (requested). For MCP tools, Anthropic chose lazy-load.

### Interesting patterns

**Cache-preserving injection.** OpenAI and Anthropic both inject dynamically-loaded tool schemas at the *end* of the context window, not at the start. This is critical: prepending to the context invalidates the KV cache for all prior turns (cache miss = 2–3× cost). Appending to the context preserves the cache. Our `instructions` field is a static 3 086 character block sent in the `serverInfo` initialize response — it is always at the beginning of the system prompt and cannot be cache-optimised. Dynamic tool loading that appends at the tail is the architecture both major providers are converging on.

**Namespace ≤ 10 rule.** Both OpenAI and LlamaIndex independently arrive at the same heuristic: keep each tool namespace under 10 items. Above that, routing accuracy degrades because the model cannot hold all options in its working memory. Our current catalog bundles all tools from a single server into one namespace — `tv` has 89 tools, `ibkr` has 39. Sub-namespace grouping by functional domain would improve routing accuracy at negligible implementation cost.

**85%–92.8% token reduction from lazy loading alone.** The convergence of Anthropic (85%), Bifrost (92.8%), and our own compression pipeline (88–99%) around the same order-of-magnitude number validates the approach. The remaining variation is in what "lazy loading" means: our model keeps all schemas out of context by default (strongest); Anthropic loads schemas on demand per-turn (medium); classic MCP loads everything upfront (weakest).

**Preload vs lazy-load for skills/instructions.** Anthropic's own infrastructure has not solved this for skills despite solving it for tools. The pattern they use for MCP tools (capability declaration in `serverInfo.instructions`, full schema on demand) is directly analogous to what we do for the conductor meta-tool catalog vs the backend tool catalog. We already have the right architecture; we should document it clearly as an explicit design decision.

### Versus mcp-conductor

Our 29-meta-tool list is always loaded at session start — we inject it in `tools/list`. Backend tools are never injected. This is already a strong position. The gap is that we expose a 3 086-character `instructions` block that is static and front-loaded. Converting the instructions to a shorter header + on-demand resource (e.g., `conductor://guide`) would reduce our session-start token cost and allow the static prefix to be cache-hit on repeated sessions.

---

## Five Specific Patterns to Adopt or Adapt

### Pattern 1 — Compact `.pyi`-style catalog stubs (from Bifrost)

**The problem:** When a user calls `discover_tools` on a 498-tool catalog, the response injects verbose JSON Schema fragments into the context. A single tool's `inputSchema` costs 50–300 tokens depending on parameter count. Across 498 tools, full-schema disclosure is prohibitive; our current approach returns descriptions + parameter names only, but even this is verbose.

**The steal:** Bifrost's `.pyi` stub format represents a tool as a Python-signature line: `def search(query: str, limit: int = 10) -> list[dict]`. A stub for the most complex tool costs ~20 tokens vs 200 for the equivalent JSON Schema. The LLM understands Python type signatures extremely well — they are arguably more readable than JSON Schema.

**Adoption path:** Add a `format` parameter to `discover_tools`: `"format": "stub"` returns the compact Python-signature format; `"format": "schema"` returns the current JSON Schema format. Default to `"stub"` in `lean` mode. No change to the backend protocol; the transformation is in `src/server/catalog.ts`. Estimated token reduction: 60–80% on discovery responses.

### Pattern 2 — Embedding-based `findTool` with pre-built ANN index (from Semantic Router + LlamaIndex)

**The problem:** `findTool` at 10 000 tools has a p99 of 359 ms. BM25 keyword matching misses semantic synonyms ("list my positions" does not match tools whose description says "retrieve current holdings"). As the conductor becomes a popular aggregation point, tool counts will grow.

**The steal:** Pre-embed all tool descriptions at server startup using a lightweight local embedding model (e.g., `all-MiniLM-L6-v2` via ONNX — 22 MB, ~2 ms per query, no API call). Store embeddings in a flat-file ANN index (HNSW via `hnswlib-node` or similar). At query time: embed the user's query, cosine-search the ANN index for top-10 candidates, return those to the LLM. Index build time at 10 000 tools is ~5 s; query time is < 1 ms at any scale.

**Adoption path:** Add `src/registry/embedding-index.ts`. Replace `findTool`'s BM25 implementation with embedding search as the primary path; keep BM25 as a fallback for exact tool-name lookups. The ONNX model can be bundled with the npm package (no external API dependency). Estimated p99 improvement: 359 ms → < 5 ms at 10 000 tools.

### Pattern 3 — Tool description override layer (from MetaMCP + arXiv 2602.14878)

**The problem:** 97.1% of real-world MCP tool descriptions contain quality defects. The conductor cannot fix upstream servers, but it can fix what the LLM sees. Currently we have no mechanism for operators to improve or annotate tool descriptions at the gateway layer.

**The steal:** MetaMCP's `namespace_tool_mappings` override layer allows any tool's description, name, or annotations to be overridden per-namespace without touching the upstream server. The schema is simple: `{ "serverName.toolName": { "description": "...", "title": "..." } }`.

**Adoption path:** Add an optional `"toolOverrides"` key to `.mcp-conductor.json` server entries. When the conductor builds its catalog from a server's `tools/list` response, it merges any configured overrides before indexing. No change to the protocol; purely a pre-processing step in `src/hub/mcp-hub.ts`. An operator can then run `set_diag_mode` to see which tool call triggered failures, identify the description defect, and add a targeted override to the config. Estimated impact: based on the research, well-targeted description fixes yield a 5.85 pp improvement in agent task success rates.

### Pattern 4 — Per-client tool scoping via virtual keys (from Bifrost)

**The problem:** The conductor currently exposes all backend tools to all connected clients equally. A Claude Code session has the same view as an automated agent runner or a junior developer's IDE session. There is no mechanism to restrict a client to a subset of tools (e.g., read-only tools only, or a specific server's tools only).

**The steal:** Bifrost's virtual key system attaches a `tools_to_auto_execute` and `tools_to_execute` allow-list to each API key. A client authenticating with key `k1` can only see and call the tools in its allow-list. Per-tool (not per-server) scoping is the key insight — it is finer-grained than our existing per-server routing config.

**Adoption path:** Extend the conductor's auth/config model to support named profiles with tool allow-lists. A profile is a named set of `{ server: "*", tool: "pattern" }` filter rules. Clients connecting with a specific profile header get a filtered `tools/list` and `discover_tools` response. The schema is small; the enforcement point is `src/server/passthrough-registrar.ts` (filter during tool registration) and `src/server/mcp-server.ts` (filter during `discover_tools`). This is a prerequisite for any multi-user or team deployment scenario.

### Pattern 5 — Session-scoped progressive tool disclosure (from FastMCP 3 + OpenAI Tool Search)

**The problem:** The conductor's `instructions` field (3 086 chars, ~770 tokens) is static and injected at the start of every session. It cannot be cache-optimised because it is front-loaded. As we add more meta-tools and capabilities, this block will grow unless actively pruned.

**The steal:** FastMCP 3 uses session-aware Transforms to reveal or hide tools based on session state. OpenAI and Anthropic both inject dynamically-loaded tool schemas at the *tail* of the context (cache-preserving). The pattern is: announce capability at session start with a short header, load detail on demand.

**Adoption path for the instructions field:** Shorten `serverInfo.instructions` to a two-line capability declaration (~100 chars, ~25 tokens): `"mcp-conductor v3: 22 servers, 498 tools. Call list_servers or discover_tools to explore."` Move the full guide to a `conductor://guide` resource that can be fetched on demand. This reduces session-start cost from ~770 tokens to ~25 tokens — a 96% reduction on the instructions overhead. Implement in `src/server/mcp-server.ts` (the `initialize` handler) and `src/server/catalog.ts` (add the resource).

**Adoption path for tool disclosure:** Add a session-context concept to the conductor: after the first `discover_tools` call in a session, the conductor notes which server families were queried and can pre-warm those servers' idle connections (the MetaMCP idle-session pattern). This links tool discovery to connection lifecycle — the most-recently-discovered tools get their connections kept hot.

---

## Summary Table

| Project | Type | Their edge | Our edge | Steal? |
|---------|------|-----------|----------|--------|
| FastMCP 3 | Server framework | Provider/Transform composability, session-scoped disclosure | Token compression, caching, multi-server aggregation | Transform pattern for modes |
| mcp-proxy | Transport bridge | URL-path routing, stateless mode, `/status` endpoint | Everything above transport | Status endpoint, stateless mode |
| Smithery | Registry/hosting | 7 300 server catalogue, ephemeral key handling, bundles | Orchestration layer | Registry search meta-tool |
| IBM ContextForge | Enterprise gateway | REST/gRPC bridging, mDNS federation, A2A support | Token compression, PII, developer-local focus | Admin UI concept |
| Bifrost | Commercial gateway | Code Mode (92.8% reduction), `.pyi` stubs, virtual keys | Caching, delta encoding, PII tokenization | .pyi stubs, virtual keys |
| MetaMCP | Aggregator | Description overrides, idle sessions, middleware pipeline | Semantic search, compression, open-source single binary | Description override layer |
| Hyper-MCP | WASM runtime | WASM isolation, OCI signing, declared permissions | Aggregation, token budget, developer UX | WASM patterns (future) |
| rust-mcp-sdk / prism | Rust SDKs | Sub-ms overhead, multi-level health, multiplexing | JS ecosystem, all higher-layer features | Multi-level health checks |
| Semantic Router + LlamaIndex | Routing libraries | Embedding-based routing (< 1 ms), two-stage funnel | MCP-specific integration, full conductor stack | Embedding ANN index |
| OpenAI / Anthropic Tool Search | Platform features | Cache-preserving tail injection, ≤ 10 per namespace | Open standard, server-side, no vendor lock | Short instructions + on-demand guide |

---

## Key Numbers Referenced

| Source | Metric | Value |
|--------|--------|-------|
| Bifrost (508 tools, 16 servers) | Token reduction via Code Mode | 92.8% |
| Anthropic Tool Search | Token reduction from lazy loading | 85% |
| mcp-conductor (our baseline) | Token compression range | 88–99% |
| arXiv 2602.14878 | Tool descriptions with quality defects | 97.1% |
| arXiv 2602.14878 | Performance gain from description fix | +5.85 pp task success |
| Bifrost | Gateway overhead per request at 5k RPS | 11 µs |
| prism-mcp-rs | Protocol overhead | < 0.5 ms |
| Semantic Router | Routing latency vs LLM routing | 100 ms vs 5 000 ms |
| mcp-conductor findTool | p99 at 10 000 tools | 359 ms |
| mcp-conductor baseline | Cold-start to tools/list | 10 468 ms |
| OpenAI namespacing | Recommended tools per namespace | ≤ 10 |
| MetaMCP | Cold-start mitigation | Idle session pre-allocation |
| FastMCP 3.4.2 | GitHub stars | 25 600 |
| Smithery | Registered servers | 7 300+ |

---

## What mcp-conductor Is Doing Right That Others Are Not

1. **LRU + CBOR disk cache with delta encoding** — no other surveyed project has a caching layer at the tool-result level. Bifrost has no cache. MetaMCP has no cache. ContextForge has Redis cache at the federation layer, not at the tool-result layer.

2. **PII tokenization** — running PII detection and reversible tokenization on tool inputs/outputs before they reach the LLM. None of the surveyed projects do this.

3. **Per-call telemetry via `set_diag_mode`** — fine-grained token + wall-clock telemetry per individual tool call, returned to the LLM as structured data. Unique to mcp-conductor.

4. **Compare mode** — running the same call against two backend routing configurations and diffing the results. Useful for A/B testing description overrides or routing changes. Not found in any surveyed project.

5. **Open-source single binary (npx)** — no Docker, no Redis, no Kubernetes. The entire conductor runs as a Node.js process. Bifrost is commercial; ContextForge needs Redis; MetaMCP needs Docker. We have the lowest total system cost for the individual developer target market.

---

_File: `docs/findings/2026-06-12-perf-audit/12-similar-projects.md`_
