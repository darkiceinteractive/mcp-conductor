# Core Concepts

## The Context Window as a Bottleneck

Every Claude session has a context window — a finite buffer that holds the entire conversation, including all tool calls and their responses. The context window is not a scratchpad that gets cleared between operations. It is a permanent, append-only log of everything that has happened in the session.

This matters for MCP-heavy workflows. When Claude calls `read_file` on a 10KB TypeScript file, those 10KB are now in the context window forever. When it reads a second file, another 10KB. After reading 20 files for a code analysis task, 200KB of raw file content is pinned in context — content that Claude has already processed and no longer needs, but cannot release.

The result is context pressure: as the window fills, Claude's ability to reason about earlier parts of the conversation degrades. Long agentic tasks become unreliable. Sessions hit their limits prematurely. Costs escalate.

## How Tool Calls Pollute Context

Each MCP tool call has two components that enter context:

1. **The tool call itself** — the tool name and parameters. Usually small.
2. **The tool response** — the raw data returned. Often large.

For a task like "analyze all TypeScript files in this repository for unused exports":

```
Without MCP Conductor — what ends up in context:
─────────────────────────────────────────────────
list_directory("/src")           → 200-line directory listing
read_file("index.ts")            → 300 lines of code
read_file("utils.ts")            → 450 lines of code
read_file("components/App.tsx")  → 600 lines of code
... × 40 more files
─────────────────────────────────────────────────
Total added to context: ~40,000 tokens
```

Every one of those responses is permanent. Claude cannot "forget" the raw content of `index.ts` once it has been read via a direct tool call.

## The Sandbox Pattern

MCP Conductor introduces a different pattern: instead of Claude making individual tool calls and receiving their raw responses, Claude writes a program that does the work. The program runs in a sandboxed Deno environment, calling MCP servers internally. Only the program's final return value enters Claude's context.

```
With MCP Conductor — what ends up in context:
─────────────────────────────────────────────
execute_code("""
  const fs = mcp.server('filesystem');
  const files = await fs.call('list_directory', { path: '/src' });
  const results = [];
  for (const f of files.entries.filter(e => e.name.endsWith('.ts'))) {
    const content = await fs.call('read_file', { path: f.path });
    const exports = findUnusedExports(content.contents);
    if (exports.length > 0) results.push({ file: f.name, exports });
  }
  return results;
""")
→ [{ file: "utils.ts", exports: ["formatDate", "parseQuery"] }]
─────────────────────────────────────────────
Total added to context: ~300 tokens
```

The raw file contents — all 40,000 tokens of them — existed only inside the Deno sandbox. They were processed, filtered, and discarded. Claude receives only the actionable conclusion.

## The Working Memory Analogy

Think of it like the difference between a CPU register and disk storage.

When a CPU computes something, it loads data into registers (fast, temporary), does its work, and writes back only the result. The intermediate values in registers are gone after the computation completes. This is efficient.

A direct MCP tool call is like writing every intermediate value to a permanent log. Every file you read, every API response you receive, every intermediate result — all of it stored forever in the context window, even when you only needed it for one step.

MCP Conductor gives Claude a set of CPU registers: the Deno sandbox. Intermediate data lives there temporarily. Only the final result gets written to the permanent log (context).

## Exclusive vs Passthrough Mode

MCP Conductor supports two operating modes, controlled by the `exclusive` field in `~/.mcp-conductor.json`.

### Exclusive mode (`"exclusive": true`)

In exclusive mode, Claude sees **only** `mcp-conductor` in its MCP server list. All other servers (GitHub, filesystem, Brave Search, etc.) are hidden — they exist in `~/.mcp-conductor.json` and are accessible from inside the Deno sandbox, but Claude cannot call them directly.

This enforces the pattern. Claude has no choice but to use `execute_code` for all MCP operations, because direct tool calls are not available.

```
Claude's visible tools (exclusive mode):
  mcp-conductor: execute_code, list_servers, discover_tools,
                 get_metrics, add_server, ...

Claude's invisible servers (sandbox-only):
  github, filesystem, brave-search, memory, ...
```

**When to use:** Always, unless you have a specific reason to allow direct calls. Exclusive mode is the recommended default.

### Passthrough mode (`"exclusive": false`)

In passthrough mode, both `mcp-conductor` and all backend servers are visible to Claude. Claude can call `execute_code` for batch operations and also make individual direct tool calls when it judges a single call is sufficient.

This offers more flexibility but loses the guarantee of token efficiency. Claude may choose to make direct calls for simple operations, and those responses will enter context normally.

**When to use:** Debugging, or when you want Claude to have full access to both patterns and make its own judgment.

## The mcp.* Runtime API

Inside every `execute_code` call, a global `mcp` object is available. This is the bridge between your TypeScript code and all configured MCP servers.

The API is intentionally simple:

```typescript
// Get a reference to a named server
const github = mcp.server('github');

// Call a tool on that server
const result = await github.call('search_repositories', {
  query: 'language:typescript stars:>1000'
});

// Run multiple calls in parallel
const [repos, issues] = await mcp.batch([
  () => github.call('search_repositories', { query: 'ai tools' }),
  () => github.call('search_issues', { query: 'good first issue' }),
]);

// Stream progress back to Claude in real-time
mcp.progress('Searching repositories...');
```

See the full [Sandbox API reference](/api/sandbox-api) for all available methods.
