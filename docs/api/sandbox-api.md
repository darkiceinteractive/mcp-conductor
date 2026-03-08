# Sandbox API (mcp.*)

Inside every `execute_code` call, a global `mcp` object is injected into the Deno runtime. This object is your interface to all configured MCP servers.

The sandbox runs Deno with TypeScript support. You can use modern TypeScript syntax, `async/await`, `Promise.all`, and the full Deno standard library. The only restriction is network access: the sandbox can only reach the MCP Conductor bridge on localhost — it cannot make arbitrary outbound HTTP requests.

## mcp.server(name)

Returns a server handle for the named MCP server.

```typescript
const github = mcp.server('github');
const fs = mcp.server('filesystem');
const brave = mcp.server('brave-search');
```

The `name` must match a key in the `servers` object in `~/.mcp-conductor.json`.

If the server is not connected, subsequent `.call()` invocations will throw an error with a message indicating the server name and available alternatives.

### Shorthand access

Servers can also be accessed as properties on the `mcp` object directly:

```typescript
// These are equivalent:
const result1 = await mcp.server('github').call('search_repositories', { query: 'ai' });
const result2 = await mcp.github.call('search_repositories', { query: 'ai' });
```

The property shorthand does not work for server names that conflict with `mcp`'s own method names (`server`, `batch`, `progress`, `searchTools`).

---

## server.call(tool, params?)

Calls a tool on the server and returns the result.

```typescript
const github = mcp.server('github');

const result = await github.call('search_repositories', {
  query: 'language:typescript topic:mcp stars:>100'
});
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tool` | string | Yes | Name of the tool to call |
| `params` | object | No | Parameters to pass to the tool |

**Returns:** `Promise<any>` — the raw response from the MCP server.

**Throws:** If the server is not connected, the tool does not exist, or the server returns an error.

### Example: Read and process a file

```typescript
const fs = mcp.server('filesystem');

const file = await fs.call('read_file', {
  path: '/Users/you/projects/myapp/package.json'
});

const pkg = JSON.parse(file.contents);
return {
  name: pkg.name,
  version: pkg.version,
  depCount: Object.keys(pkg.dependencies ?? {}).length
};
```

### Example: GitHub search with filtering

```typescript
const gh = mcp.server('github');

const results = await gh.call('search_repositories', {
  query: 'mcp server language:typescript',
  sort: 'stars',
  order: 'desc'
});

return results.items
  .filter(r => r.stargazers_count > 50)
  .map(r => ({
    name: r.full_name,
    stars: r.stargazers_count,
    updated: r.updated_at.slice(0, 10)
  }));
```

---

## mcp.batch(fns)

Runs an array of functions in parallel and returns their results in order. This is the recommended way to make multiple independent MCP calls — it is faster than sequential `await` chains and respects per-server rate limits defined in `~/.mcp-conductor.json`.

```typescript
const [repos, issues, prs] = await mcp.batch([
  () => gh.call('search_repositories', { query: 'mcp typescript' }),
  () => gh.call('search_issues', { query: 'is:open label:bug repo:anthropics/claude-code' }),
  () => gh.call('list_pull_requests', { owner: 'anthropics', repo: 'claude-code', state: 'open' }),
]);
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `fns` | `Array<() => Promise<any>>` | Array of zero-argument async functions |

**Returns:** `Promise<any[]>` — results in the same order as the input array.

**Rate limit behaviour:** If a server has `rateLimit` configured and calls exceed the limit, `mcp.batch` will automatically queue excess calls rather than rejecting them. The returned array always has one result per input function.

### Example: Parallel file reads

```typescript
const fs = mcp.server('filesystem');

const filePaths = [
  '/Users/you/project/src/index.ts',
  '/Users/you/project/src/utils.ts',
  '/Users/you/project/src/types.ts',
];

const contents = await mcp.batch(
  filePaths.map(path => () => fs.call('read_file', { path }))
);

return filePaths.map((path, i) => ({
  file: path.split('/').pop(),
  lines: contents[i].contents.split('\n').length,
  size: contents[i].contents.length
}));
```

### Example: Multi-server batch

```typescript
const gh = mcp.server('github');
const brave = mcp.server('brave-search');

const [githubResults, webResults] = await mcp.batch([
  () => gh.call('search_repositories', { query: 'deno mcp' }),
  () => brave.call('brave_web_search', { query: 'Deno MCP servers 2024', count: 5 }),
]);

return {
  github: githubResults.items.slice(0, 3).map(r => r.full_name),
  web: webResults.results.slice(0, 3).map(r => r.title)
};
```

### Error handling in batch

Individual failures do not cancel the entire batch. Use `Promise.allSettled` semantics explicitly if you need to handle partial failures:

```typescript
const files = ['/exists.ts', '/maybe-missing.ts', '/also-exists.ts'];

const results = await Promise.allSettled(
  files.map(path => fs.call('read_file', { path }))
);

return results.map((r, i) => ({
  file: files[i],
  ok: r.status === 'fulfilled',
  lines: r.status === 'fulfilled' ? r.value.contents.split('\n').length : 0,
  error: r.status === 'rejected' ? r.reason.message : null
}));
```

---

## mcp.progress(message)

Streams a progress message back to Claude in real-time, while the sandbox continues executing. Claude sees these messages as the code runs, rather than waiting for the final result.

```typescript
mcp.progress('Fetching repository list...');
const repos = await gh.call('search_repositories', { query: 'mcp' });

mcp.progress(`Found ${repos.total_count} repositories. Reading top 10...`);
const details = await mcp.batch(
  repos.items.slice(0, 10).map(r => () => gh.call('get_repository', {
    owner: r.owner.login,
    repo: r.name
  }))
);

mcp.progress('Analysing results...');
// ... processing ...

return summary;
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | string | Progress message to stream to Claude |

**Returns:** `void` — fire and forget. Does not affect execution.

Progress messages appear in Claude's response stream as the code runs. They are not included in the final return value and do not consume additional context tokens.

---

## console.log(...)

`console.log` calls are captured and surfaced as progress output. This works the same as `mcp.progress` but is more ergonomic for debugging:

```typescript
console.log('Starting analysis...');
const result = await someOperation();
console.log('Result count:', result.length);
return result;
```

---

## mcp.searchTools(query)

Search for tools across all connected servers. Returns matching tools with their server names and descriptions.

```typescript
const fileTools = await mcp.searchTools('file');
// Returns: [{ server: 'filesystem', tool: 'read_file', description: '...' }, ...]
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search term matched against tool names and descriptions |

**Returns:** `Promise<Array<{ server: string, tool: string, description: string }>>`

Useful when you know what you want to do but not which server or tool name to use.

---

## TypeScript Support

The sandbox runs full Deno TypeScript. You can define types, use generics, and import from URLs:

```typescript
// Define types for better code clarity
interface RepoSummary {
  name: string;
  stars: number;
  language: string | null;
}

const gh = mcp.server('github');
const results = await gh.call('search_repositories', {
  query: 'mcp typescript',
  sort: 'stars'
});

const summaries: RepoSummary[] = results.items.map((r: any) => ({
  name: r.full_name,
  stars: r.stargazers_count,
  language: r.language
}));

return summaries.filter(r => r.stars > 100);
```

Deno's standard library is available via URL imports:

```typescript
import { format } from 'https://deno.land/std@0.220.0/datetime/mod.ts';

const now = format(new Date(), 'yyyy-MM-dd');
mcp.progress(`Running analysis for ${now}`);
```

---

## Sandbox Permissions

The Deno sandbox runs with minimal permissions by design:

| Permission | Setting | Why |
|------------|---------|-----|
| Network | `127.0.0.1` only | Can only reach the MCP bridge |
| Filesystem | None | All file operations go through MCP servers |
| Environment | None | No access to host environment variables |
| Subprocess | None | Cannot spawn child processes |
| FFI | None | No native code execution |

This means you cannot do `fetch('https://example.com')` from sandbox code — use the `brave-search` or `playwright` MCP server instead. You cannot read files directly with `Deno.readTextFile` — use the `filesystem` MCP server. This is intentional: keeping all I/O through MCP servers means all access is logged, rate-limited, and controlled.
