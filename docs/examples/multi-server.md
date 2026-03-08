# Multi-Server Batch

This example shows how to call multiple MCP servers in a single `execute_code` call, combining results from GitHub and the filesystem in parallel.

## The Problem

A task like "compare the dependencies in my local project's package.json against the latest releases on GitHub" would normally require:

1. `read_file` on `package.json` — enters context
2. For each dependency: a GitHub API call to check the latest release — each enters context
3. Manual comparison logic in Claude's reasoning

With 20 dependencies, that is 21 tool call responses in context, plus Claude must compare them without the benefit of computed structures.

## The Solution

One `execute_code` call reads the local file, queries GitHub for all dependencies in parallel (respecting any rate limits), computes the comparison, and returns only a structured diff.

## Full Example

```typescript
// Compare local dependency versions against GitHub latest releases
const fs = mcp.server('filesystem');
const gh = mcp.server('github');

mcp.progress('Reading package.json...');

// Read the local package.json
const pkgFile = await fs.call('read_file', {
  path: '/Users/you/projects/myapp/package.json'
});
const pkg = JSON.parse(pkgFile.contents);

const allDeps = {
  ...pkg.dependencies,
  ...pkg.devDependencies
};

const depNames = Object.keys(allDeps).slice(0, 20); // Cap at 20 for demo
mcp.progress(`Found ${depNames.length} dependencies. Checking latest versions...`);

// Query GitHub for each package's latest release in parallel
const releases = await mcp.batch(
  depNames.map(name => () =>
    gh.call('get_repository_releases', {
      owner: name.startsWith('@') ? name.split('/')[0].slice(1) : name,
      repo: name.startsWith('@') ? name.split('/')[1] : name,
      per_page: 1
    }).catch(() => null) // Some packages may not be on GitHub
  )
);

mcp.progress('Comparing versions...');

const results = depNames.map((name, i) => {
  const localVersion = allDeps[name].replace(/[\^~]/, '');
  const latest = releases[i]?.[0]?.tag_name?.replace(/^v/, '') ?? 'unknown';

  let status: 'current' | 'outdated' | 'unknown' = 'unknown';
  if (latest !== 'unknown') {
    status = localVersion === latest ? 'current' : 'outdated';
  }

  return { name, local: localVersion, latest, status };
});

const outdated = results.filter(r => r.status === 'outdated');
const current = results.filter(r => r.status === 'current');

return {
  summary: {
    total: results.length,
    outdated: outdated.length,
    current: current.length,
    unknown: results.filter(r => r.status === 'unknown').length
  },
  outdated,
  current
};
```

## What Claude Receives

```json
{
  "summary": {
    "total": 20,
    "outdated": 5,
    "current": 12,
    "unknown": 3
  },
  "outdated": [
    { "name": "chalk", "local": "5.3.0", "latest": "5.4.1", "status": "outdated" },
    { "name": "vitest", "local": "2.1.8", "latest": "2.2.0", "status": "outdated" }
  ],
  "current": [
    { "name": "typescript", "local": "5.7.2", "latest": "5.7.2", "status": "current" }
  ]
}
```

Clean, structured, actionable — and only ~200 tokens.

## Token Comparison

| Approach | Tool Calls | Approx. Context Tokens |
|----------|-----------|----------------------|
| Direct tool calls | 21 | ~18,000 |
| execute_code | 1 | ~250 |
| **Savings** | **20 fewer** | **~99%** |

## More Multi-Server Patterns

### GitHub issues + local CHANGELOG comparison

```typescript
const fs = mcp.server('filesystem');
const gh = mcp.server('github');

// Run both in parallel
const [changelog, issues] = await mcp.batch([
  () => fs.call('read_file', { path: '/Users/you/project/CHANGELOG.md' }),
  () => gh.call('list_repository_issues', {
    owner: 'myorg',
    repo: 'myrepo',
    state: 'closed',
    labels: 'bug',
    per_page: 20
  })
]);

// Find bugs closed since last release that aren't mentioned in changelog
const changelogText = changelog.contents;
const unmentioned = issues
  .filter((issue: any) => !changelogText.includes(`#${issue.number}`))
  .map((issue: any) => ({ number: issue.number, title: issue.title }));

return {
  changelogLength: changelogText.split('\n').length,
  closedBugs: issues.length,
  unmentionedInChangelog: unmentioned
};
```

### Brave Search + filesystem — research with context

```typescript
const brave = mcp.server('brave-search');
const fs = mcp.server('filesystem');

const topic = 'Deno 2.0 breaking changes';
mcp.progress(`Researching: ${topic}`);

// Search the web and read local notes simultaneously
const [webResults, localNotes] = await mcp.batch([
  () => brave.call('brave_web_search', { query: topic, count: 5 }),
  () => fs.call('read_file', { path: '/Users/you/notes/deno-migration.md' })
    .catch(() => ({ contents: '' })) // OK if notes don't exist yet
]);

const topLinks = webResults.results.slice(0, 3).map((r: any) => ({
  title: r.title,
  url: r.url,
  snippet: r.description?.slice(0, 150)
}));

const noteLength = localNotes.contents.split('\n').filter((l: string) => l.trim()).length;

return {
  webSources: topLinks,
  localNotesLines: noteLength,
  hasLocalNotes: noteLength > 0
};
```

### GitHub code search + read matching files

```typescript
const gh = mcp.server('github');
const fs = mcp.server('filesystem');

mcp.progress('Searching GitHub for MCP server examples...');

// Search GitHub code
const codeResults = await gh.call('search_code', {
  q: 'mcp.server language:typescript filename:*.ts',
  per_page: 5
});

// Read matching files in parallel (if they're in local repo too)
const localReads = await mcp.batch(
  codeResults.items.map((item: any) =>
    () => fs.call('read_file', {
      path: `/Users/you/projects/${item.repository.name}/${item.path}`
    }).catch(() => null)
  )
);

const results = codeResults.items.map((item: any, i: number) => ({
  repo: item.repository.full_name,
  path: item.path,
  hasLocal: localReads[i] !== null,
  localLines: localReads[i]?.contents?.split('\n').length ?? 0
}));

return {
  githubMatches: results.length,
  withLocalCopy: results.filter(r => r.hasLocal).length,
  files: results
};
```
