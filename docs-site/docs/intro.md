---
sidebar_position: 1
title: Getting Started
---

# MCP Conductor

**99.7% fewer tokens. Parallel execution. One `npx` command.**

MCP Conductor is a single MCP server that orchestrates all your other MCP servers through a sandboxed Deno runtime. Instead of Claude making direct tool calls (and dumping every intermediate result into your context window), Claude writes TypeScript code that runs in an isolated sandbox. Only the final result comes back.

```
Before: 153,900 tokens → Claude context window → 153,900 tokens billed
After:  153,900 tokens → Deno sandbox → 435 tokens → Claude context window
```

**Average measured reduction: 99.7%. Verified against Anthropic's published benchmarks.**

## Quick Install

Add to your AI tool's config (`~/.claude/settings.json`, Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "npx",
      "args": ["-y", "@darkiceinteractive/mcp-conductor"]
    }
  }
}
```

Restart your AI tool. That's it — you should see `mcp-conductor` with its tools.

## 30-Second Example

```typescript
// Claude writes this code, which runs inside the Deno sandbox
const [issues, files] = await mcp.batch([
  () => mcp.server('github').call('list_issues', { owner: 'myorg', repo: 'myrepo', state: 'open' }),
  () => mcp.server('filesystem').call('list_directory', { path: '/src' })
]);

return {
  openBugs: issues.filter(i => i.labels.some(l => l.name === 'bug')).length,
  tsFiles: files.filter(f => f.name.endsWith('.ts')).length
};
// Returns: {"openBugs": 12, "tsFiles": 47}  ←  under 100 tokens
```

## What's in These Docs

| Page | What it covers |
|------|---------------|
| [Architecture](./v3/architecture) | System design, components, data flow |
| [Configuration](./v3/configuration) | All config options in `~/.mcp-conductor.json` |
| [Sandbox API](./v3/sandbox-api) | The `mcp` object available inside `execute_code` |
| [Recipes](./v3/recipes) | Practical `execute_code` examples |
| [Migration (v2 → v3)](./v3/migration) | Breaking changes and migration steps |
