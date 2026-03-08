# MCP Conductor - Token-Efficient Operations

When performing MCP operations, **use mcp-conductor's `execute_code` tool** instead of making direct MCP calls.

## When to Use execute_code

**ALWAYS use execute_code when:**
- You need 2+ MCP tool calls
- Processing, filtering, or transforming data from MCP results
- Iterating over files, repos, search results, or lists
- Working with large datasets

**Direct calls are OK only for:**
- Single, simple tool call with no processing
- Debugging or interactive exploration

## Why This Matters

Direct MCP calls put ALL data in Claude's context:
- `filesystem.list_directory` → full listing in context
- `filesystem.read_file` x 10 → 10 full files in context
- Each response consumes tokens

With execute_code:
- Write code once (small cost)
- All intermediate data stays in sandbox (zero cost)
- Only final return value in context (minimal tokens)

**Savings: 90%+ for multi-step operations**

## Quick API Reference

```typescript
// Get server client
const fs = mcp.server('filesystem');
const github = mcp.github;  // attribute style

// Call tools
const files = await fs.call('list_directory', { path: '/src' });
const repos = await github.call('search_repositories', { query: 'ai' });

// Search all tools
const tools = await mcp.searchTools('file');

// Return only what's needed
return { count: files.entries.length };
```

## Example: Process Multiple Files

```typescript
const fs = mcp.server('filesystem');
const files = await fs.call('list_directory', { path: '/src' });
const tsFiles = files.entries.filter(f => f.name.endsWith('.ts'));
const contents = await Promise.all(
  tsFiles.map(f => fs.call('read_file', { path: '/src/' + f.name }))
);
return {
  count: tsFiles.length,
  totalLines: contents.reduce((sum, c) => sum + c.split('\n').length, 0)
};
```

This processes potentially hundreds of files but only returns a small summary to context.
