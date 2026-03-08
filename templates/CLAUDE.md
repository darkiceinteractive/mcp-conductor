# MCP Conductor - Project Instructions

This project has MCP Conductor configured for token-efficient MCP operations.

## Critical: Use execute_code for MCP Operations

**ALWAYS use `mcp-conductor`'s `execute_code` tool** instead of making direct MCP tool calls when:

1. **Multiple tool calls needed** - Batch operations into a single execute_code call
2. **Processing data** - Filter, transform, or aggregate results in the sandbox
3. **Iterating over items** - Files, repos, search results, etc.
4. **Large datasets** - Process data server-side, return only summaries

### Why This Matters

Direct MCP calls consume tokens for BOTH request AND response in Claude's context. With execute_code:
- Write code once (small token cost)
- All intermediate data stays in sandbox (zero token cost)
- Only final return value enters context (minimal tokens)

**Token savings: 90%+ for multi-step operations**

### Example: Reading Multiple Files

**BAD - Direct calls (high token usage):**
```
1. filesystem.list_directory → full response in context
2. filesystem.read_file → full file in context
3. filesystem.read_file → full file in context
4. filesystem.read_file → full file in context
... (each response consumes tokens)
```

**GOOD - execute_code (minimal tokens):**
```typescript
// Use mcp-conductor's execute_code tool with this code:
const fs = mcp.server('filesystem');
const files = await fs.call('list_directory', { path: '/src' });
const tsFiles = files.entries.filter(f => f.name.endsWith('.ts'));
const contents = await Promise.all(
  tsFiles.map(f => fs.call('read_file', { path: '/src/' + f.name }))
);
// Only this summary enters Claude's context:
return {
  count: tsFiles.length,
  totalLines: contents.reduce((sum, c) => sum + c.split('\n').length, 0)
};
```

### When Direct MCP Calls Are OK

- Single, simple tool call with no processing
- Debugging or interactive exploration
- When you need streaming feedback

## Web Search Optimisation (Optional)

If `brave-search` MCP server is configured, use `mcp.batchSearch()` for efficient batched searches:

**Native WebSearch (sequential, high tokens):**
```
1. WebSearch("query 1") → full results in context
2. WebSearch("query 2") → full results in context
3. WebSearch("query 3") → full results in context
```

**mcp.batchSearch() (auto rate-limit handling, filtered):**
```typescript
// Simple: auto handles rate limits, parses results, returns top 3 per query
const results = await mcp.batchSearch([
  'React hooks best practices',
  'Vue composition API tutorial',
  'Svelte vs React performance'
], { topN: 3 });

return results;
// Returns: { "React hooks...": [{title, url, description}, ...], ... }
```

**How it works:**
- Attempts parallel execution first (fastest)
- Auto-detects rate limits from errors
- Falls back to sequential with delays if needed
- Caches rate limit status for session
- Parses text response into structured data

**For other rate-limited APIs, use mcp.batch():**
```typescript
// Generic batch with auto rate limit handling
const results = await mcp.batch([
  { server: 'github', tool: 'search_repositories', params: { query: 'ai' } },
  { server: 'github', tool: 'search_repositories', params: { query: 'ml' } },
]);
```

**Rate limit warnings (displayed in logs):**
```
⚠️  RATE LIMITED: brave-search - Free tier limit hit. Retrying with delays...
💡 TIP: Upgrade your API plan for parallel execution: https://brave.com/search/api/
```

**Benefits:**
- Automatic rate limit detection and handling
- No manual delays needed
- Parallel when possible, sequential when required
- ~80%+ token savings

**After upgrading API plan, use `forceParallel` to test:**
```typescript
const results = await mcp.batchSearch([
  'query 1', 'query 2', 'query 3', 'query 4', 'query 5'
], { topN: 3, forceParallel: true });
```

**Note:** Use native WebSearch for single searches or when brave-search isn't configured.

### Quick Reference

```typescript
// Get a server client
const github = mcp.server('github');
// Or use attribute style
const github = mcp.github;

// Call a tool
const repos = await github.call('search_repositories', { query: 'ai' });

// Search for tools across all servers
const tools = await mcp.searchTools('file');

// Log (captured in response)
mcp.log('Processing...');
```

## Available MCP Servers

Run `mcp-conductor - list_servers` to see all connected servers and their tools.
