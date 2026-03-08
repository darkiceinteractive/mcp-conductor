# File Search with Progress

This example shows how to search a large directory tree for files matching a pattern, with real-time progress streaming back to Claude as the search runs.

## The Problem

A direct approach to "find all TypeScript files that import from a specific module" would require:

1. `list_directory` on the root — response enters context
2. `list_directory` on each subdirectory — more context
3. `read_file` on each `.ts` file — potentially hundreds of large responses

A mid-size project with 200 TypeScript files would produce 200+ tool call responses in Claude's context window, easily 50,000+ tokens just for the search phase.

## The Solution

One `execute_code` call handles the entire search. Intermediate directory listings and file contents stay inside the Deno sandbox. Only the final list of matching files crosses back to Claude.

## Full Example

```typescript
// Search for TypeScript files importing from a specific module
// Reports progress as it works through the directory tree

const fs = mcp.server('filesystem');
const targetImport = '@modelcontextprotocol/sdk';
const rootPath = '/Users/you/projects/myapp';

// Recursive directory walker
async function walkDir(path: string): Promise<string[]> {
  const entries = await fs.call('list_directory', { path });
  const files: string[] = [];

  for (const entry of entries.entries) {
    if (entry.type === 'directory' && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      const subFiles = await walkDir(entry.path);
      files.push(...subFiles);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(entry.path);
    }
  }

  return files;
}

mcp.progress('Scanning directory tree...');
const allFiles = await walkDir(rootPath);
mcp.progress(`Found ${allFiles.length} TypeScript files. Searching for imports...`);

// Search files in parallel batches of 10
const matches: Array<{ file: string; lines: string[] }> = [];
const batchSize = 10;

for (let i = 0; i < allFiles.length; i += batchSize) {
  const batch = allFiles.slice(i, i + batchSize);
  const pct = Math.round((i / allFiles.length) * 100);
  mcp.progress(`Searching... ${pct}% (${i}/${allFiles.length} files)`);

  const contents = await Promise.all(
    batch.map(path => fs.call('read_file', { path }))
  );

  for (let j = 0; j < batch.length; j++) {
    const content = contents[j].contents;
    if (content.includes(targetImport)) {
      // Find the specific import lines
      const importLines = content
        .split('\n')
        .filter((line: string) => line.includes(targetImport) && line.trim().startsWith('import'));

      matches.push({
        file: batch[j].replace(rootPath + '/', ''),
        lines: importLines
      });
    }
  }
}

mcp.progress(`Search complete. Found ${matches.length} files.`);

return {
  query: targetImport,
  totalScanned: allFiles.length,
  matchCount: matches.length,
  matches
};
```

## What Claude Receives

Instead of hundreds of file contents, Claude receives a compact summary:

```json
{
  "query": "@modelcontextprotocol/sdk",
  "totalScanned": 47,
  "matchCount": 8,
  "matches": [
    {
      "file": "src/server/mcp-server.ts",
      "lines": [
        "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
        "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';"
      ]
    },
    {
      "file": "src/hub/mcp-hub.ts",
      "lines": [
        "import { Client } from '@modelcontextprotocol/sdk/client/index.js';"
      ]
    }
  ]
}
```

Eight matches from 47 files, expressed in roughly 300 tokens. The raw file contents — potentially 200KB — never touched Claude's context.

## Token Comparison

| Approach | Tool Calls | Approx. Context Tokens |
|----------|-----------|----------------------|
| Direct tool calls | 48 (1 list + 47 reads) | ~35,000 |
| execute_code | 1 | ~400 |
| **Savings** | **47 fewer** | **~99%** |

## Variations

### Search by filename pattern

```typescript
const fs = mcp.server('filesystem');

async function findFiles(dir: string, pattern: RegExp): Promise<string[]> {
  const entries = await fs.call('list_directory', { path: dir });
  const found: string[] = [];

  for (const e of entries.entries) {
    if (e.type === 'directory' && e.name !== 'node_modules' && !e.name.startsWith('.')) {
      found.push(...await findFiles(e.path, pattern));
    } else if (pattern.test(e.name)) {
      found.push(e.path);
    }
  }
  return found;
}

const testFiles = await findFiles('/Users/you/project', /\.test\.ts$/);
return { count: testFiles.length, files: testFiles };
```

### Find large files

```typescript
const fs = mcp.server('filesystem');

async function findLargeFiles(dir: string, minLines: number): Promise<any[]> {
  const entries = await fs.call('list_directory', { path: dir });
  const large: any[] = [];

  const tsFiles = entries.entries.filter(
    e => e.type === 'file' && e.name.endsWith('.ts')
  );

  const contents = await Promise.all(
    tsFiles.map(f => fs.call('read_file', { path: f.path }))
  );

  for (let i = 0; i < tsFiles.length; i++) {
    const lines = contents[i].contents.split('\n').length;
    if (lines >= minLines) {
      large.push({ file: tsFiles[i].name, lines });
    }
  }

  return large.sort((a, b) => b.lines - a.lines);
}

return await findLargeFiles('/Users/you/project/src', 200);
```
