# 05 — Presence-Layer Token Budget

Captured: 2026-06-12  
Branch: `feat/lean-defaults`  
HEAD: `f12f5f5`  
Method: char-count / 4 (ceiling) per field, summed across all registered tools.

---

## 1. PROBLEM — Current always-on cost itemised

Every time Claude initialises an MCP session the conductor injects:

1. The `serverInfo.instructions` field (system-context slot — loaded once per session and kept for every turn).
2. A `tools/list` response containing **26 meta-tool entries**, each with: `name`, `title`, `description`, `inputSchema` (with per-property `description` strings), and `outputSchema`.

The baseline measured the `instructions` field at **3 086 chars ≈ 772 tokens**. The actual always-on presence-layer cost is 5.7× that once the full `tools/list` payload is accounted for.

**Measured total: ~4 383 tokens per session.**

This is the constant tax — every Claude turn in a conductor-backed session pays this in the system prompt. At 29 cents per million input tokens (Sonnet 4.5) that is $0.0013 per session, but across a heavy user with 200 sessions/month it compounds to $0.26/month just for the overhead — before any useful work.

More importantly, the token budget matters for **context quality**: every token consumed by boilerplate is a token not available for user data.

---

## 2. EVIDENCE — Tokens per tool, per field

### 2.1 Instructions field

| Component | Chars | Tokens |
|---|---|---|
| Header sentence | 257 | 65 |
| Catalog body (6 connected servers × ~60 chars/line) | ~780 | ~195 |
| Failed-servers list (16 names) | ~220 | 55 |
| Footer sentence | 80 | 20 |
| Whitespace / punctuation overhead | ~100 | 25 |
| **Instructions total (baseline-measured)** | **3 086** | **772** |

### 2.2 Tool descriptions (26 tools)

| Tool | Chars | Tokens | Category |
|---|---|---|---|
| `execute_code` | 939 | 235 | Core |
| `list_servers` | 371 | 93 | Core |
| `discover_tools` | 440 | 110 | Core |
| `get_metrics` | 265 | 67 | Core |
| `set_mode` | 257 | 65 | Core |
| `set_diag_mode` | 445 | 112 | Diag |
| `set_compare_mode` | 629 | 158 | Diag |
| `test_server` | 332 | 83 | Mgmt |
| `diagnose_server` | 304 | 76 | Mgmt |
| `import_servers_from_claude` | 401 | 101 | Lifecycle |
| `export_to_claude` | 312 | 78 | Lifecycle |
| `recommend_routing` | 295 | 74 | Mgmt |
| `add_server` | 208 | 52 | Mgmt |
| `update_server` | 213 | 54 | Mgmt |
| `remove_server` | 211 | 53 | Mgmt |
| `passthrough_call` | 175 | 44 | Debug |
| `brave_web_search` | 171 | 43 | Core |
| `get_capabilities` | 221 | 56 | Info |
| `compare_modes` | 113 | 29 | Analysis |
| `reload_servers` | 84 | 21 | Mgmt |
| `get_memory_stats` | 108 | 27 | Admin |
| `predict_cost` | 107 | 27 | Admin |
| `replay_session` | 131 | 33 | Admin |
| `get_hot_paths` | 86 | 22 | Admin |
| `record_session` | 74 | 19 | Admin |
| `stop_recording` | 65 | 17 | Admin |
| **TOTAL** | **6 996** | **1 749** | |

### 2.3 inputSchema parameter descriptions

The MCP SDK serialises every `z.string().describe(...)` annotation into the JSON schema that Claude receives. Several are verbose:

| Field | Chars | Tokens |
|---|---|---|
| `execute_code.show_token_savings` | 554 | 139 |
| `execute_code.max_result_tokens` | 240 | 60 |
| `execute_code.code` | 54 | 14 |
| `execute_code.servers` | 42 | 11 |
| `execute_code.timeout_ms` | 52 | 13 |
| `execute_code.stream` | 42 | 11 |
| `execute_code.verbose` | 49 | 13 |
| `replay_session.modifications` (nested) | ~200 | 50 |
| `import_servers_from_claude.confirm` | 84 | 21 |
| `add_server.env` | 70 | 18 |
| All remaining 40+ simple params (avg 30 chars) | ~1 200 | ~300 |
| **Estimated total inputSchema desc** | **~2 587** | **~643** |

### 2.4 outputSchema overhead

The `outputSchema` for each tool is transmitted in `tools/list` and consumed by the client. Large ones:

| Tool | Estimated tokens |
|---|---|
| `execute_code` (deeply nested) | ~119 |
| `get_metrics` (7 nested objects) | ~130 |
| `compare_modes` (4 nested objects) | ~60 |
| `replay_session` (divergence block) | ~50 |
| Average 22 remaining tools (×40t each) | ~880 |
| **Estimated total outputSchema** | **~1 239** |

### 2.5 Tool names

26 tool names, average 3.8 tokens each:

| | Tokens |
|---|---|
| Tool name strings | ~100 |

### 2.6 Grand total

| Layer | Tokens | % of total |
|---|---|---|
| `instructions` field | 772 | 18% |
| Tool descriptions (26 tools) | 1 749 | 40% |
| inputSchema param descriptions | 643 | 15% |
| outputSchema definitions | 1 119 | 26% |
| Tool names | 100 | 2% |
| **TOTAL presence-layer cost** | **4 383** | 100% |

The baseline reported ~770 tokens. That was only the `instructions` field. The **real always-on cost is ~4 383 tokens** — 5.7× higher. The tool list is the dominant cost (81%).

---

## 3. OPTIONS — Cuts ranked by token-saved / utility-lost

### Cut A — Hide 6 pure-admin tools behind `admin_mode` flag   **−438 tokens**

Tools: `predict_cost`, `get_hot_paths`, `record_session`, `stop_recording`, `replay_session`, `get_memory_stats`.

These are developer/debugging tools. The model never needs them autonomously:

- `predict_cost`: developer curiosity, not decision-making.
- `get_hot_paths`: latency profiling — developer-only.
- `record_session` / `stop_recording` / `replay_session`: session capture pipeline — no autonomous use case.
- `get_memory_stats`: process diagnostics — no autonomous use case.

Mechanism: guard registration behind `config.adminMode === true` (default false). The tools remain available via config — they are not deleted.

| Component | Saved |
|---|---|
| Description tokens (6 tools) | 145 |
| inputSchema/outputSchema overhead (est) | 270 |
| Tool name tokens | 23 |
| **Total** | **438** |

Utility loss: zero for normal operation. Operators who need them set `adminMode: true` in config.

---

### Cut D — Move `import_servers_from_claude` and `export_to_claude` to CLI-only   **−269 tokens**

These tools exist to migrate/export config — a one-time setup action. The model has no legitimate need to call them autonomously:

- `import_servers_from_claude`: reads Claude config files and writes conductor config — this is exactly what `npx mcp-conductor setup` does. The MCP tool surface is wrong for this.
- `export_to_claude`: generates a JSON snippet the user pastes into config. Should be `npx mcp-conductor export`, not an in-session tool.

Both already have CLI equivalents (`scripts/setup.sh`, export logic in `src/server/mcp-server.ts`). Move them there, remove from registered tools.

| Component | Saved |
|---|---|
| import desc (101t) + export desc (78t) | 179 |
| inputSchema/outputSchema overhead | 90 |
| **Total** | **269** |

Utility loss: minor — `import` dry-run mode is occasionally useful for discovery. Provide as `test_server`-like dry-run CLI instead.

---

### Cut B — Collapse `add_server` / `remove_server` / `update_server` into `manage_server({op})`   **−208 tokens**

Three tools with near-identical structure: load config → mutate → save → reload. Each carries:
- A 52–54 token description
- A 50-token inputSchema/outputSchema

Merged into one tool with `op: 'add' | 'remove' | 'update'`. The merged description is shorter because the common context ("saves to ~/.mcp-conductor.json, triggers reload") is stated once:

```
Proposed description (38 tokens):
"Manage backend MCP servers: op='add' (add+connect), 'remove' (disconnect+remove),
'update' (update config). Saves to ~/.mcp-conductor.json and reloads."
```

| Component | Saved |
|---|---|
| Three descriptions (159t) → one (38t) | 121 |
| Three schemas → one larger schema (−80t net) | 80 |
| Name overhead reduction | 7 |
| **Total** | **208** |

Utility loss: minimal. The op parameter makes intent explicit. Add `op` as the first required field.

---

### Cut F — Tighten `execute_code.show_token_savings` parameter description   **−119 tokens**

Current (554 chars / 139 tokens): explains the full token formula including the 256t/KB heuristic, the passthrough formula `(toolCalls × 150) + (dataBytes / 1024 × 256)`, the execution formula, the "not applicable" note, and the global config override.

The model does not need to understand the formula to use the parameter. The formula belongs in docs, not in a tool description.

Proposed (77 chars / 19 tokens):
```
"If true, attach tokenSavings block (formula details in docs). Default: false."
```

Saved: **~119 tokens** on a single param description.

Utility loss: none — Claude already knows what a token savings block is from context.

---

### Cut E — Tighten `set_compare_mode` description   **−117 tokens**

Current (629 chars / 158 tokens): three paragraphs, including a detailed explanation of the double-execution risk for destructive tools.

The safety warning belongs in the `warning` field returned by the tool itself, not in the description. The description should give the model what it needs to decide to call the tool.

Proposed (162 chars / 41 tokens):
```
"Toggle compare mode on/off. When ON, passthrough calls also run via execute_code
for benchmarking — DESTRUCTIVE tools fire TWICE. Process-local; resets on restart."
```

The existing runtime `warning` field in the response already surfaces the destructive-tool caution. Duplicating it in the description is redundant.

Saved: **~117 tokens**.

---

### Cut C — Move `compare_modes` to catalog resource   **−89 tokens**

`compare_modes` is a static analysis tool that estimates token usage for different modes. It has no side effects and is never called autonomously by the model in normal operation — it is used by developers understanding the cost model.

Move it to a `conductor://compare-modes` resource (read-only, no tool slot consumed). The model can still access it but it is no longer present in every `tools/list`.

Saved: **~89 tokens** (29t desc + ~60t outputSchema).

---

### Cut G — Tighten `execute_code.max_result_tokens` param description   **−29 tokens**

Current (240 chars / 60 tokens): explains the trimming algorithm ("arrays truncated, deep structures clipped"), mentions `result_trimmed` metadata.

Proposed (122 chars / 31 tokens):
```
"Max tokens for result. Trims arrays/structures if exceeded; attaches result_trimmed flag.
Default: 2000. Set 0 to disable."
```

Saved: **~29 tokens**.

---

### Cut H — Tighten `instructions` field header and footer   **−27 tokens**

Current header includes the phrase "Their schemas stay out of context to save tokens." — this is meta-commentary explaining the design rationale. The model does not need to understand why the schemas are absent; it needs to know how to find tools.

Current footer: "Full per-server detail: read resource conductor://catalog or call list_servers." (20 tokens)  
Proposed footer: "Full detail: conductor://catalog or list_servers." (13 tokens)

Saved: **~27 tokens**.

---

## 4. IMPACT — Projected total reduction

| Cut | Tokens Saved | Cumulative |
|---|---|---|
| A — Admin tools gated | 438 | 438 |
| D — import/export CLI-only | 269 | 707 |
| B — Collapse server mgmt tools | 208 | 915 |
| F — execute_code param desc | 119 | 1 034 |
| E — set_compare_mode desc | 117 | 1 151 |
| C — compare_modes → resource | 89 | 1 240 |
| G — max_result_tokens param | 29 | 1 269 |
| H — instructions header/footer | 27 | 1 296 |
| **TOTAL** | **1 296** | |

| Metric | Current | After all cuts |
|---|---|---|
| Total presence-layer tokens | 4 383 | **3 087** |
| % reduction | — | **30%** |
| Tool count in tools/list | 26 | **17** (excluding admin) |
| Instructions field | 772 tokens | ~745 tokens |
| Dominant cost | descriptions (40%) | descriptions (~37%) |

At 200 sessions/month the all-cuts scenario saves ~259 000 input tokens per month per heavy user — roughly $0.075/month at Sonnet 4.5 pricing. The larger value is the freed context headroom.

---

## 5. RECOMMENDED PATH

### Phase 1 — No breaking changes (1–2 hours)

Apply cuts **E, F, G, H** — pure description/param tightening in `mcp-server.ts`. No API surface change, no config schema change, no tests need updating.

Expected reduction: **−200 tokens** (cumulative).

Files: `src/server/mcp-server.ts` (description strings at lines 802, 1286, 827, 1340).

### Phase 2 — Tool surface reduction (half-day)

Apply cuts **C** and **D**:
- Move `compare_modes` registration to a resource handler (`conductor://compare-modes`).
- Remove `import_servers_from_claude` and `export_to_claude` from `registerTools()`. Ensure their logic is wired into the CLI (verify `src/bin/cli.ts` exposes equivalent `import` and `export` subcommands — add if missing).

Expected additional reduction: **−358 tokens**.

Files: `src/server/mcp-server.ts`, `src/bin/cli.ts`, update `STATIC_TOOL_NAMES` in `src/server/passthrough-registrar.ts`.

### Phase 3 — Admin gate (half-day)

Apply cuts **A** and **B**:

- Add `adminMode?: boolean` field to conductor config schema (`src/config/schema.ts`).
- Guard the 6 admin tool registrations in `registerTools()` behind `if (this.config.adminMode)`.
- Collapse `add_server`, `remove_server`, `update_server` into a single `manage_server` tool with `op` parameter. Update `STATIC_TOOL_NAMES` accordingly.

Expected additional reduction: **−646 tokens**.

Files: `src/config/schema.ts`, `src/server/mcp-server.ts`, `src/server/passthrough-registrar.ts`.

### Phase 1+2+3 combined savings

| Phase | Tokens saved |
|---|---|
| Phase 1 (text tightening) | 200 |
| Phase 2 (surface reduction) | 358 |
| Phase 3 (admin gate + collapse) | 646 |
| | |
| **From 4 383 → ~3 087 tokens** | **1 296 (30%)** |

### What to do about the real 30% ceiling

After all cuts, the dominant costs will be:

1. Core tool descriptions (`execute_code` 235t, `discover_tools` 110t, `list_servers` 93t) — these are load-bearing and should not be cut.
2. `outputSchema` definitions (~1 119t estimated) — these are the next frontier. The MCP SDK transmits output schemas in `tools/list`; most clients (including Claude) do not use them for routing decisions. A follow-on audit should measure whether removing `outputSchema` from all tools produces a measurable drop without breaking any client. That cut alone could save ~800–1 000 additional tokens (18–23%).

The `outputSchema` cut is not included here because it requires verifying client-side behaviour and may affect structured output handling; it should be a separate audit item.

---

*File: `docs/findings/2026-06-12-perf-audit/05-presence-layer-budget.md`*  
*Size: ~8.7 KB*  
*Headline: presence layer costs ~4 383 tokens/session (5.7× the reported 770t); 30% reduction (−1 296t) achievable in three phases with no breaking changes.*
