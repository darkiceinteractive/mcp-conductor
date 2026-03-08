/**
 * Code Samples for MCP Conductor Tests
 *
 * Standard code samples for testing execute_code functionality.
 * Each sample is designed to exercise specific patterns and scenarios.
 */

export interface CodeSample {
  name: string;
  description: string;
  code: string;
  expectedServers: string[];
  estimatedToolCalls: number;
  estimatedDataKb: number;
  category: 'simple' | 'aggregation' | 'transformation' | 'error-handling' | 'streaming';
}

/**
 * Simple single-server operations
 */
export const simpleSamples: CodeSample[] = [
  {
    name: 'filesystem-list',
    description: 'List directory contents',
    code: `
const fs = mcp.server('filesystem');
const result = await fs.call('list_directory', { path: '.' });
return { files: result };
    `.trim(),
    expectedServers: ['filesystem'],
    estimatedToolCalls: 1,
    estimatedDataKb: 1,
    category: 'simple',
  },
  {
    name: 'filesystem-read',
    description: 'Read a single file',
    code: `
const fs = mcp.server('filesystem');
const result = await fs.call('read_file', { path: '/test/package.json' });
return { content: result.content };
    `.trim(),
    expectedServers: ['filesystem'],
    estimatedToolCalls: 1,
    estimatedDataKb: 2,
    category: 'simple',
  },
  {
    name: 'context7-lookup',
    description: 'Look up library documentation',
    code: `
const ctx = mcp.server('context7');
const lib = await ctx.call('resolve-library-id', { libraryName: 'react' });
const docs = await ctx.call('get-library-docs', {
  context7CompatibleLibraryID: lib.libraryId,
  topic: 'hooks'
});
return { library: lib.name, docs: docs.content };
    `.trim(),
    expectedServers: ['context7'],
    estimatedToolCalls: 2,
    estimatedDataKb: 5,
    category: 'simple',
  },
];

/**
 * Multi-server aggregation operations
 */
export const aggregationSamples: CodeSample[] = [
  {
    name: 'multi-file-read',
    description: 'Read multiple files and aggregate',
    code: `
const fs = mcp.server('filesystem');

const files = ['package.json', 'tsconfig.json', 'README.md'];
const results = await Promise.all(
  files.map(f => fs.call('read_file', { path: f }))
);

return {
  fileCount: results.length,
  totalSize: results.reduce((sum, r) => sum + (r.content?.length || 0), 0)
};
    `.trim(),
    expectedServers: ['filesystem'],
    estimatedToolCalls: 3,
    estimatedDataKb: 10,
    category: 'aggregation',
  },
  {
    name: 'cross-server-aggregate',
    description: 'Combine data from multiple MCP servers',
    code: `
const fs = mcp.server('filesystem');
const ctx = mcp.server('context7');

const [files, lib] = await Promise.all([
  fs.call('list_directory', { path: '.' }),
  ctx.call('resolve-library-id', { libraryName: 'typescript' })
]);

return {
  filesFound: typeof files === 'string' ? files.split('\\n').length : 0,
  library: lib.name,
  combined: true
};
    `.trim(),
    expectedServers: ['filesystem', 'context7'],
    estimatedToolCalls: 2,
    estimatedDataKb: 5,
    category: 'aggregation',
  },
  {
    name: 'directory-scan',
    description: 'Scan directory tree and count files',
    code: `
const fs = mcp.server('filesystem');

const tree = await fs.call('directory_tree', { path: '/test' });
const lines = tree.tree?.split('\\n') || [];

const stats = {
  directories: lines.filter(l => l.includes('/')).length,
  files: lines.filter(l => l.includes('.')).length,
  total: lines.length
};

return stats;
    `.trim(),
    expectedServers: ['filesystem'],
    estimatedToolCalls: 1,
    estimatedDataKb: 20,
    category: 'aggregation',
  },
  {
    name: 'large-aggregation',
    description: 'Aggregate large amount of data from multiple sources',
    code: `
const fs = mcp.server('filesystem');
const ctx = mcp.server('context7');
const mem = mcp.server('memory');

// Parallel calls to multiple servers
const [dir, lib, memory] = await Promise.all([
  fs.call('list_directory', { path: '/src' }),
  ctx.call('resolve-library-id', { libraryName: 'vitest' }),
  mem.call('list_projects', {})
]);

// Parse filesystem text format
const fileList = typeof dir === 'string'
  ? dir.split('\\n').filter(l => l.startsWith('[FILE]')).map(l => l.replace('[FILE] ', ''))
  : [];

// Read multiple files
const fileContents = await Promise.all(
  fileList.slice(0, 5).map(f => fs.call('read_file', { path: \`/src/\${f}\` }))
);

return {
  filesRead: fileContents.length,
  totalChars: fileContents.reduce((sum, r) => sum + (r.content?.length || 0), 0),
  library: lib.name,
  projects: memory.projects?.length || 0
};
    `.trim(),
    expectedServers: ['filesystem', 'context7', 'memory'],
    estimatedToolCalls: 8,
    estimatedDataKb: 50,
    category: 'aggregation',
  },
];

/**
 * Data transformation operations
 */
export const transformationSamples: CodeSample[] = [
  {
    name: 'json-extract',
    description: 'Extract specific fields from JSON file',
    code: `
const fs = mcp.server('filesystem');

const file = await fs.call('read_file', { path: '/test/package.json' });
const pkg = JSON.parse(file.content || '{}');

return {
  name: pkg.name,
  version: pkg.version,
  dependencies: Object.keys(pkg.dependencies || {}).length,
  devDependencies: Object.keys(pkg.devDependencies || {}).length
};
    `.trim(),
    expectedServers: ['filesystem'],
    estimatedToolCalls: 1,
    estimatedDataKb: 5,
    category: 'transformation',
  },
  {
    name: 'filter-files',
    description: 'Filter directory listing by type',
    code: `
const fs = mcp.server('filesystem');

const dir = await fs.call('list_directory', { path: '/src' });
const lines = typeof dir === 'string' ? dir.split('\\n') : [];

const filtered = {
  directories: lines.filter(l => l.startsWith('[DIR]')).map(l => l.replace('[DIR] ', '')),
  tsFiles: lines.filter(l => l.includes('.ts')).map(l => l.replace('[FILE] ', '')),
  jsonFiles: lines.filter(l => l.includes('.json')).map(l => l.replace('[FILE] ', ''))
};

return filtered;
    `.trim(),
    expectedServers: ['filesystem'],
    estimatedToolCalls: 1,
    estimatedDataKb: 2,
    category: 'transformation',
  },
  {
    name: 'complex-transformation',
    description: 'Complex data transformation with multiple steps',
    code: `
const fs = mcp.server('filesystem');
const ctx = mcp.server('context7');

// Step 1: Get file list
const dir = await fs.call('list_directory', { path: '/src' });
const tsFiles = (typeof dir === 'string' ? dir.split('\\n') : [])
  .filter(l => l.includes('.ts'))
  .map(l => l.replace('[FILE] ', ''));

// Step 2: Read each TypeScript file
const contents = await Promise.all(
  tsFiles.slice(0, 3).map(f => fs.call('read_file', { path: \`/src/\${f}\` }))
);

// Step 3: Extract exports
const exports = contents.map(c => {
  const content = c.content || '';
  const exportMatches = content.match(/export (const|function|class|interface|type) (\\w+)/g) || [];
  return exportMatches.length;
});

// Step 4: Get docs for common library
const lib = await ctx.call('resolve-library-id', { libraryName: 'typescript' });

return {
  filesAnalysed: tsFiles.length,
  totalExports: exports.reduce((a, b) => a + b, 0),
  averageExports: exports.length ? exports.reduce((a, b) => a + b, 0) / exports.length : 0,
  referenceLibrary: lib.name
};
    `.trim(),
    expectedServers: ['filesystem', 'context7'],
    estimatedToolCalls: 5,
    estimatedDataKb: 30,
    category: 'transformation',
  },
];

/**
 * Error handling operations
 */
export const errorHandlingSamples: CodeSample[] = [
  {
    name: 'graceful-error',
    description: 'Handle errors gracefully with fallback',
    code: `
const fs = mcp.server('filesystem');

let result;
try {
  result = await fs.call('read_file', { path: '/nonexistent/file.txt' });
} catch (error) {
  result = { content: 'File not found, using default' };
}

return { success: true, data: result };
    `.trim(),
    expectedServers: ['filesystem'],
    estimatedToolCalls: 1,
    estimatedDataKb: 1,
    category: 'error-handling',
  },
  {
    name: 'partial-failure',
    description: 'Handle partial failures in batch operations',
    code: `
const fs = mcp.server('filesystem');

const files = ['exists.txt', 'missing.txt', 'another.txt'];
const results = await Promise.allSettled(
  files.map(f => fs.call('read_file', { path: f }))
);

const successful = results.filter(r => r.status === 'fulfilled').length;
const failed = results.filter(r => r.status === 'rejected').length;

return {
  attempted: files.length,
  successful,
  failed,
  partialSuccess: successful > 0 && failed > 0
};
    `.trim(),
    expectedServers: ['filesystem'],
    estimatedToolCalls: 3,
    estimatedDataKb: 3,
    category: 'error-handling',
  },
  {
    name: 'server-unavailable',
    description: 'Handle unavailable server gracefully',
    code: `
let data = null;

try {
  const fetch = mcp.server('fetch');
  data = await fetch.call('fetch', { url: 'https://api.example.com' });
} catch (error) {
  // Fallback to cached/default data
  data = { cached: true, message: 'Using cached response' };
}

return data;
    `.trim(),
    expectedServers: ['fetch'],
    estimatedToolCalls: 1,
    estimatedDataKb: 1,
    category: 'error-handling',
  },
];

/**
 * Streaming/progress operations
 */
export const streamingSamples: CodeSample[] = [
  {
    name: 'progress-reporting',
    description: 'Report progress during long operation',
    code: `
const fs = mcp.server('filesystem');

const files = ['file1.ts', 'file2.ts', 'file3.ts', 'file4.ts', 'file5.ts'];
const results = [];

for (let i = 0; i < files.length; i++) {
  mcp.progress?.(\`Processing \${i + 1}/\${files.length}: \${files[i]}\`);

  try {
    const result = await fs.call('read_file', { path: files[i] });
    results.push({ file: files[i], success: true });
  } catch (e) {
    results.push({ file: files[i], success: false });
  }
}

return {
  processed: results.length,
  successful: results.filter(r => r.success).length
};
    `.trim(),
    expectedServers: ['filesystem'],
    estimatedToolCalls: 5,
    estimatedDataKb: 10,
    category: 'streaming',
  },
  {
    name: 'sequential-thinking-flow',
    description: 'Use sequential thinking with multiple steps',
    code: `
const thinking = mcp.server('sequential-thinking');

const thoughts = [];
let thoughtNumber = 1;
let needMore = true;

while (needMore && thoughtNumber <= 5) {
  const result = await thinking.call('sequentialthinking', {
    thought: \`Analysing step \${thoughtNumber}\`,
    thoughtNumber,
    totalThoughts: 5,
    nextThoughtNeeded: thoughtNumber < 5
  });

  thoughts.push(result);
  needMore = result.nextThoughtNeeded;
  thoughtNumber++;
}

return {
  totalThoughts: thoughts.length,
  complete: !needMore,
  summary: thoughts.map(t => t.thought)
};
    `.trim(),
    expectedServers: ['sequential-thinking'],
    estimatedToolCalls: 5,
    estimatedDataKb: 5,
    category: 'streaming',
  },
];

/**
 * Get all code samples
 */
export function getAllSamples(): CodeSample[] {
  return [
    ...simpleSamples,
    ...aggregationSamples,
    ...transformationSamples,
    ...errorHandlingSamples,
    ...streamingSamples,
  ];
}

/**
 * Get samples by category
 */
export function getSamplesByCategory(category: CodeSample['category']): CodeSample[] {
  return getAllSamples().filter((s) => s.category === category);
}

/**
 * Get sample by name
 */
export function getSampleByName(name: string): CodeSample | undefined {
  return getAllSamples().find((s) => s.name === name);
}

/**
 * Get samples for specific server(s)
 */
export function getSamplesForServers(servers: string[]): CodeSample[] {
  return getAllSamples().filter((s) =>
    s.expectedServers.some((es) => servers.includes(es))
  );
}

/**
 * Get samples by estimated data size range
 */
export function getSamplesByDataSize(minKb: number, maxKb: number): CodeSample[] {
  return getAllSamples().filter(
    (s) => s.estimatedDataKb >= minKb && s.estimatedDataKb <= maxKb
  );
}

/**
 * Sample collection for token savings validation
 */
export const tokenSavingsTestSamples = {
  small: getSamplesByDataSize(0, 5),
  medium: getSamplesByDataSize(5, 20),
  large: getSamplesByDataSize(20, 100),
};

/**
 * Sample collection for mode comparison tests
 */
export const modeComparisonSamples = {
  simple: simpleSamples.slice(0, 2),
  complex: aggregationSamples.slice(0, 2),
  transformation: transformationSamples.slice(0, 2),
};
