# Cross-Session Memory

This example shows how to use the `memory` MCP server to persist data across Claude sessions. Each session can store findings, and later sessions can retrieve and build on them — without any data entering the context window beyond compact summaries.

## The Problem

Claude's context window does not persist between sessions. When you start a new conversation, everything from the previous one is gone. For long-running projects — tracking progress on a codebase, building up a knowledge base, or monitoring changes over time — this is a fundamental limitation.

The naive workaround is to paste previous findings into each new session, but this immediately consumes context and degrades reasoning quality as the pasted content grows.

## The Solution

Use the `memory` MCP server (or `memory-bank-mcp`) as a persistent store. Session 1 analyses something and stores its findings with structured entities. Session 2 retrieves only the summary, compares it against new data, and stores the diff. Claude's context only ever sees the compact summaries — never the raw stored data.

## Session 1: Store Findings

In the first session, analyse a codebase and store the results:

```typescript
// Session 1 — Initial analysis, store baseline
const fs = mcp.server('filesystem');
const mem = mcp.server('memory');

mcp.progress('Analysing codebase structure...');

// Count files by type
async function countFiles(dir: string): Promise<Record<string, number>> {
  const entries = await fs.call('list_directory', { path: dir });
  const counts: Record<string, number> = {};

  for (const e of entries.entries) {
    if (e.type === 'directory' && e.name !== 'node_modules' && !e.name.startsWith('.')) {
      const sub = await countFiles(e.path);
      for (const [ext, n] of Object.entries(sub)) {
        counts[ext] = (counts[ext] ?? 0) + n;
      }
    } else if (e.type === 'file') {
      const ext = e.name.includes('.') ? e.name.split('.').pop()! : 'no-ext';
      counts[ext] = (counts[ext] ?? 0) + 1;
    }
  }
  return counts;
}

const fileCounts = await countFiles('/Users/you/projects/myapp/src');
const today = new Date().toISOString().slice(0, 10);
const totalFiles = Object.values(fileCounts).reduce((a, b) => a + b, 0);

mcp.progress('Storing baseline in memory...');

// Create a memory entity for this snapshot
await mem.call('create_entities', {
  entities: [{
    name: `codebase-snapshot-${today}`,
    entityType: 'CodebaseSnapshot',
    observations: [
      `Date: ${today}`,
      `Total files: ${totalFiles}`,
      `TypeScript files: ${fileCounts['ts'] ?? 0}`,
      `JavaScript files: ${fileCounts['js'] ?? 0}`,
      `JSON files: ${fileCounts['json'] ?? 0}`,
      `Test files: ${fileCounts['test'] ?? 0}`,
    ]
  }]
});

// Also store as a relation to the project entity
await mem.call('create_relations', {
  relations: [{
    from: 'myapp-project',
    to: `codebase-snapshot-${today}`,
    relationType: 'has_snapshot'
  }]
});

return {
  stored: true,
  snapshotId: `codebase-snapshot-${today}`,
  summary: { totalFiles, ...fileCounts }
};
```

## Session 2: Retrieve and Compare

In a later session (days or weeks later), retrieve the stored snapshot and compare it against the current state:

```typescript
// Session 2 — Retrieve previous snapshot and compute diff
const fs = mcp.server('filesystem');
const mem = mcp.server('memory');

mcp.progress('Loading previous snapshot from memory...');

// Get all snapshots for this project
const graph = await mem.call('read_graph', {});

const snapshots = graph.entities
  .filter((e: any) => e.entityType === 'CodebaseSnapshot')
  .sort((a: any, b: any) => a.name.localeCompare(b.name));

if (snapshots.length === 0) {
  return { error: 'No previous snapshots found. Run Session 1 first.' };
}

// Parse the most recent snapshot's observations
const latest = snapshots[snapshots.length - 1];
const prevData: Record<string, number> = {};
for (const obs of latest.observations) {
  const match = obs.match(/^(.+): (\d+)$/);
  if (match) {
    prevData[match[1]] = parseInt(match[2], 10);
  }
}

mcp.progress('Analysing current codebase...');

// Recount current files
async function countFiles(dir: string): Promise<Record<string, number>> {
  const entries = await fs.call('list_directory', { path: dir });
  const counts: Record<string, number> = {};
  for (const e of entries.entries) {
    if (e.type === 'directory' && e.name !== 'node_modules' && !e.name.startsWith('.')) {
      const sub = await countFiles(e.path);
      for (const [ext, n] of Object.entries(sub)) {
        counts[ext] = (counts[ext] ?? 0) + n;
      }
    } else if (e.type === 'file') {
      const ext = e.name.includes('.') ? e.name.split('.').pop()! : 'no-ext';
      counts[ext] = (counts[ext] ?? 0) + 1;
    }
  }
  return counts;
}

const currentCounts = await countFiles('/Users/you/projects/myapp/src');
const currentTotal = Object.values(currentCounts).reduce((a, b) => a + b, 0);

// Compute the diff
const today = new Date().toISOString().slice(0, 10);
const prevTotal = prevData['Total files'] ?? 0;
const diff = {
  from: latest.name.replace('codebase-snapshot-', ''),
  to: today,
  totalFiles: { before: prevTotal, after: currentTotal, delta: currentTotal - prevTotal },
  typescript: {
    before: prevData['TypeScript files'] ?? 0,
    after: currentCounts['ts'] ?? 0,
    delta: (currentCounts['ts'] ?? 0) - (prevData['TypeScript files'] ?? 0)
  }
};

mcp.progress('Storing new snapshot...');

// Store the new snapshot
await mem.call('create_entities', {
  entities: [{
    name: `codebase-snapshot-${today}`,
    entityType: 'CodebaseSnapshot',
    observations: [
      `Date: ${today}`,
      `Total files: ${currentTotal}`,
      `TypeScript files: ${currentCounts['ts'] ?? 0}`,
      `JavaScript files: ${currentCounts['js'] ?? 0}`,
      `JSON files: ${currentCounts['json'] ?? 0}`,
    ]
  }]
});

return {
  diff,
  snapshotsStored: snapshots.length + 1,
  currentCounts
};
```

## What Claude Receives (Session 2)

```json
{
  "diff": {
    "from": "2024-01-10",
    "to": "2024-01-17",
    "totalFiles": { "before": 47, "after": 53, "delta": 6 },
    "typescript": { "before": 31, "after": 36, "delta": 5 }
  },
  "snapshotsStored": 2,
  "currentCounts": { "ts": 36, "js": 2, "json": 8, "md": 5, "yml": 2 }
}
```

Claude can immediately reason about the change: "6 new files added in the past week, 5 of them TypeScript."

## Why This Works

The key insight is that Claude never sees the raw memory contents directly. The graph of entities and observations stays inside the sandbox on retrieval; only the processed diff crosses back into context. As the project grows and more snapshots accumulate, the context cost remains constant.

## Alternative: Using memory-bank-mcp

For simpler use cases, `memory-bank-mcp` stores structured markdown files rather than a knowledge graph:

```typescript
// Store a summary
const mb = mcp.server('memory-bank');
await mb.call('write_memory', {
  key: 'project/myapp/last-analysis',
  content: JSON.stringify({ date: today, fileCounts, totalFiles })
});

// Later session: retrieve it
const stored = await mb.call('read_memory', {
  key: 'project/myapp/last-analysis'
});
const previous = JSON.parse(stored.content);
```

`memory-bank-mcp` is simpler to reason about for structured data. Use `@modelcontextprotocol/server-memory` when you need entity relationships and graph queries.
