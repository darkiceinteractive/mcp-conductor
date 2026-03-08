# Sandbox API Reference

Inside every `execute_code` call, a global `mcp` object is injected into the Deno runtime. This is your interface to all configured MCP servers.

The sandbox runs Deno with full TypeScript support, `async/await`, and `Promise.all`. The only restriction is network access: the sandbox can only reach the MCP Conductor bridge on localhost.

## mcp.server(name)

Returns a server handle for the named MCP server.

```typescript
const github = mcp.server('github');
const fs = mcp.server('filesystem');
const brave = mcp.server('brave-search');
```

The `name` must match a key in `~/.mcp-conductor.json`. If the server is not connected, subsequent `.call()` invocations will throw.

### Shorthand access

Servers can also be accessed as properties:

```typescript
// These are equivalent:
await mcp.server('github').call('search_repositories', { query: 'ai' });
await mcp.github.call('search_repositories', { query: 'ai' });
```

The shorthand does not work for names that conflict with `mcp`'s own methods (`server`, `batch`, `progress`, `searchTools`).

## server.call(tool, params?)

Calls a tool on the server and returns the result.

```typescript
const result = await github.call('search_repositories', {
  query: 'language:typescript topic:mcp stars:>100'
});
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tool` | string | Yes | Tool name |
| `params` | object | No | Tool parameters |

**Returns:** `Promise<any>` — the response from the MCP server.

**Throws:** If the server is not connected, tool does not exist, or server returns an error.

## mcp.batch(fns)

Runs an array of functions in parallel. Respects per-server rate limits.

```typescript
const [repos, issues, prs] = await mcp.batch([
  () => gh.call('search_repositories', { query: 'mcp typescript' }),
  () => gh.call('search_issues', { query: 'is:open label:bug' }),
  () => gh.call('list_pull_requests', { owner: 'org', repo: 'repo', state: 'open' }),
]);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `fns` | `Array<() => Promise<any>>` | Array of zero-argument async functions |

**Returns:** `Promise<any[]>` — results in the same order as input.

**Rate limit behaviour:** If a server has rate limits configured, `mcp.batch` automatically queues excess calls rather than rejecting them.

### Error handling in batch

Individual failures do not cancel the batch. Use `Promise.allSettled` for partial failure handling:

```typescript
const results = await Promise.allSettled(
  files.map(path => fs.call('read_file', { path }))
);
return results.map((r, i) => ({
  file: files[i],
  ok: r.status === 'fulfilled',
  lines: r.status === 'fulfilled' ? r.value.contents.split('\n').length : 0,
}));
```

## mcp.batchSearch(queries, options?)

Convenience wrapper for parallel web searches with automatic rate limiting.

```typescript
const results = await mcp.batchSearch(
  ['query 1', 'query 2', 'query 3'],
  { topN: 3 }
);
```

## mcp.progress(message)

Streams a progress message back to Claude in real-time while execution continues.

```typescript
mcp.progress('Fetching repository list...');
const repos = await gh.call('search_repositories', { query: 'mcp' });
mcp.progress(`Found ${repos.total_count} repos. Processing...`);
```

Progress messages appear in Claude's response stream as the code runs. They do not consume additional context tokens.

## mcp.searchTools(query)

Search for tools across all connected servers.

```typescript
const fileTools = await mcp.searchTools('file');
// [{ server: 'filesystem', tool: 'read_file', description: '...' }, ...]
```

## console.log(...)

`console.log` calls are captured and surfaced as progress output, similar to `mcp.progress`.

## TypeScript Support

Full TypeScript is supported. Define types, use generics, import from URLs:

```typescript
interface RepoSummary {
  name: string;
  stars: number;
}

const results: RepoSummary[] = repos.items.map((r: any) => ({
  name: r.full_name,
  stars: r.stargazers_count,
}));
return results.filter(r => r.stars > 100);
```

## Sandbox Permissions

| Permission | Setting | Reason |
|------------|---------|--------|
| Network | `127.0.0.1` only | Can only reach the MCP bridge |
| Filesystem | None | All file ops go through MCP servers |
| Environment | None | No access to host env vars |
| Subprocess | None | Cannot spawn child processes |
| FFI | None | No native code execution |

You cannot use `fetch()` for arbitrary URLs or `Deno.readTextFile()` for direct file access. All I/O goes through MCP servers, ensuring operations are logged, rate-limited, and controlled.
