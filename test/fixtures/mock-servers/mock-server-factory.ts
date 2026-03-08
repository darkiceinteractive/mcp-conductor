/**
 * Mock MCP Server Factory
 *
 * Creates configurable mock MCP servers for testing different scenarios.
 * Response formats match real-world MCP server behaviour discovered during testing.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type ServerStatus = 'connected' | 'error' | 'disconnected' | 'connecting';

export interface MockToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface MockServerConfig {
  name: string;
  status: ServerStatus;
  tools: MockToolDefinition[];
  responseFormat: 'text' | 'json' | 'object';
  latencyMs?: number;
  errorRate?: number; // 0-1, probability of error
  customResponses?: Record<string, (params: Record<string, unknown>) => unknown>;
}

export interface ServerInfo {
  name: string;
  status: ServerStatus;
  toolCount: number;
  connectedAt?: Date;
  lastError?: string;
}

export interface BridgeHandlers {
  listServers: () => ServerInfo[];
  listTools: (serverName: string) => MockToolDefinition[];
  callTool: (
    serverName: string,
    toolName: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;
  searchTools: (query: string, limit?: number) => Array<{
    server: string;
    tool: string;
    description: string;
  }>;
}

/**
 * Default mock responses matching real MCP server formats
 */
const DEFAULT_RESPONSES: Record<string, Record<string, (params: Record<string, unknown>) => unknown>> = {
  filesystem: {
    // Filesystem returns text format with [DIR]/[FILE] prefixes
    list_directory: (params) => {
      const path = params.path as string || '/test';
      return `[DIR] src\n[DIR] test\n[FILE] package.json\n[FILE] README.md\n[FILE] tsconfig.json`;
    },
    // read_file returns object with content property
    read_file: (params) => ({
      content: `// Mock file content for ${params.path}\nexport const test = true;`,
    }),
    read_text_file: (params) => ({
      content: `Mock text content for ${params.path}`,
    }),
    directory_tree: (params) => ({
      tree: `${params.path}\n├── src/\n│   └── index.ts\n├── test/\n│   └── test.ts\n└── package.json`,
    }),
    search_files: (params) => ({
      matches: [
        { path: '/test/src/index.ts', line: 10 },
        { path: '/test/src/utils.ts', line: 25 },
      ],
    }),
    get_file_info: (params) => ({
      path: params.path,
      size: 1024,
      isDirectory: false,
      modified: new Date().toISOString(),
    }),
    create_directory: () => ({ success: true }),
    write_file: () => ({ success: true }),
    edit_file: () => ({ success: true }),
    move_file: () => ({ success: true }),
  },

  context7: {
    // Context7 returns structured JSON
    'resolve-library-id': (params) => ({
      libraryId: `/mock/${params.libraryName}`,
      name: params.libraryName,
      description: `Documentation for ${params.libraryName}`,
      codeSnippets: 150,
      reputation: 'High',
    }),
    'get-library-docs': (params) => ({
      content: `# ${params.context7CompatibleLibraryID} Documentation\n\n## Overview\nMock documentation content for testing.\n\n## API Reference\n- function1()\n- function2()`,
      topic: params.topic || 'general',
      page: params.page || 1,
    }),
  },

  memory: {
    // Memory returns JSON graph structure
    allpepper_memory_bank: () => ({
      entities: [
        { name: 'Project', type: 'concept', properties: { description: 'Test project' } },
        { name: 'Feature', type: 'concept', properties: { status: 'active' } },
      ],
      relations: [
        { from: 'Project', to: 'Feature', type: 'contains' },
      ],
    }),
    list_projects: () => ({
      projects: ['project-a', 'project-b'],
    }),
    memory_bank_read: (params) => ({
      content: `Memory content for ${params.key}`,
      timestamp: new Date().toISOString(),
    }),
    memory_bank_write: () => ({ success: true }),
    memory_bank_update: () => ({ success: true }),
  },

  'sequential-thinking': {
    // Sequential thinking requires thoughtNumber parameter
    sequentialthinking: (params) => {
      if (typeof params.thoughtNumber !== 'number') {
        throw new Error('Invalid thoughtNumber: must be a number');
      }
      return {
        thoughtNumber: params.thoughtNumber,
        thought: `Step ${params.thoughtNumber}: Analysing the problem...`,
        nextThoughtNeeded: (params.thoughtNumber as number) < 3,
        totalThoughts: 3,
      };
    },
  },

  playwright: {
    // Playwright returns structured results
    navigate: (params) => ({
      success: true,
      url: params.url,
      title: 'Mock Page Title',
    }),
    screenshot: () => ({
      data: 'base64-mock-screenshot-data...',
      format: 'png',
      width: 1920,
      height: 1080,
    }),
    click: () => ({ success: true }),
    fill: () => ({ success: true }),
    evaluate: (params) => ({
      result: `Evaluated: ${params.script}`,
    }),
  },

  fetch: {
    // Fetch returns HTTP response format
    fetch: (params) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mock: true, url: params.url }),
    }),
  },

  github: {
    // GitHub returns structured API responses
    list_commits: () => ({
      commits: [
        { sha: 'abc123', message: 'feat: initial commit', author: 'test' },
        { sha: 'def456', message: 'fix: bug fix', author: 'test' },
      ],
    }),
    get_file_contents: (params) => ({
      content: btoa(`// Content of ${params.path}`),
      encoding: 'base64',
      sha: 'mock-sha-123',
    }),
    search_code: (params) => ({
      items: [
        { path: 'src/index.ts', repository: 'test/repo' },
      ],
      total_count: 1,
    }),
    create_issue: () => ({
      number: 42,
      url: 'https://github.com/test/repo/issues/42',
    }),
    create_pull_request: () => ({
      number: 123,
      url: 'https://github.com/test/repo/pull/123',
    }),
  },

  git: {
    // Git returns text output
    status: () => 'On branch main\nnothing to commit, working tree clean',
    log: () => 'abc123 feat: latest commit\ndef456 fix: previous fix',
    diff: () => '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
  },
};

/**
 * Create default tool definitions for common MCP servers
 */
export function createDefaultTools(serverName: string): MockToolDefinition[] {
  const toolSets: Record<string, MockToolDefinition[]> = {
    filesystem: [
      { name: 'list_directory', description: 'List directory contents' },
      { name: 'read_file', description: 'Read file contents' },
      { name: 'read_text_file', description: 'Read text file' },
      { name: 'write_file', description: 'Write file contents' },
      { name: 'edit_file', description: 'Edit file contents' },
      { name: 'create_directory', description: 'Create a directory' },
      { name: 'directory_tree', description: 'Get directory tree' },
      { name: 'search_files', description: 'Search for files' },
      { name: 'get_file_info', description: 'Get file information' },
      { name: 'move_file', description: 'Move or rename file' },
    ],
    context7: [
      { name: 'resolve-library-id', description: 'Resolve library to Context7 ID' },
      { name: 'get-library-docs', description: 'Get library documentation' },
    ],
    memory: [
      { name: 'allpepper_memory_bank', description: 'Access memory bank' },
      { name: 'list_projects', description: 'List projects' },
      { name: 'memory_bank_read', description: 'Read from memory bank' },
      { name: 'memory_bank_write', description: 'Write to memory bank' },
      { name: 'memory_bank_update', description: 'Update memory bank' },
    ],
    'sequential-thinking': [
      { name: 'sequentialthinking', description: 'Process sequential thoughts' },
    ],
    playwright: [
      { name: 'navigate', description: 'Navigate to URL' },
      { name: 'screenshot', description: 'Take screenshot' },
      { name: 'click', description: 'Click element' },
      { name: 'fill', description: 'Fill input field' },
      { name: 'evaluate', description: 'Evaluate JavaScript' },
    ],
    fetch: [
      { name: 'fetch', description: 'Make HTTP request' },
    ],
    github: [
      { name: 'list_commits', description: 'List repository commits' },
      { name: 'get_file_contents', description: 'Get file contents from repo' },
      { name: 'search_code', description: 'Search code in repositories' },
      { name: 'create_issue', description: 'Create GitHub issue' },
      { name: 'create_pull_request', description: 'Create pull request' },
    ],
    git: [
      { name: 'status', description: 'Get git status' },
      { name: 'log', description: 'Get git log' },
      { name: 'diff', description: 'Get git diff' },
    ],
  };

  return toolSets[serverName] || [
    { name: 'default_tool', description: 'Default mock tool' },
  ];
}

/**
 * Factory class for creating mock MCP servers
 */
export class MockServerFactory {
  private servers: Map<string, MockServerConfig> = new Map();

  /**
   * Add a mock server with configuration
   */
  addServer(config: MockServerConfig): this {
    this.servers.set(config.name, config);
    return this;
  }

  /**
   * Add a pre-configured server matching real MCP behaviour
   */
  addRealServer(name: string, status: ServerStatus = 'connected'): this {
    const tools = createDefaultTools(name);
    this.servers.set(name, {
      name,
      status,
      tools,
      responseFormat: name === 'filesystem' || name === 'git' ? 'text' : 'json',
      customResponses: DEFAULT_RESPONSES[name],
    });
    return this;
  }

  /**
   * Add multiple real servers at once
   */
  addRealServers(servers: Array<{ name: string; status?: ServerStatus }>): this {
    for (const { name, status } of servers) {
      this.addRealServer(name, status);
    }
    return this;
  }

  /**
   * Create an error server for testing error handling
   */
  addErrorServer(name: string, errorMessage: string = 'Server connection failed'): this {
    this.servers.set(name, {
      name,
      status: 'error',
      tools: [],
      responseFormat: 'text',
      customResponses: {
        '*': () => {
          throw new Error(errorMessage);
        },
      },
    });
    return this;
  }

  /**
   * Create a slow server for testing timeouts
   */
  addSlowServer(name: string, latencyMs: number): this {
    const tools = createDefaultTools(name);
    this.servers.set(name, {
      name,
      status: 'connected',
      tools,
      responseFormat: 'json',
      latencyMs,
      customResponses: DEFAULT_RESPONSES[name],
    });
    return this;
  }

  /**
   * Create a flaky server for testing error recovery
   */
  addFlakyServer(name: string, errorRate: number): this {
    const tools = createDefaultTools(name);
    this.servers.set(name, {
      name,
      status: 'connected',
      tools,
      responseFormat: 'json',
      errorRate,
      customResponses: DEFAULT_RESPONSES[name],
    });
    return this;
  }

  /**
   * Build the bridge handlers for testing
   */
  build(): BridgeHandlers {
    const servers = this.servers;

    return {
      listServers: (): ServerInfo[] => {
        return Array.from(servers.values()).map((s) => ({
          name: s.name,
          status: s.status,
          toolCount: s.tools.length,
          connectedAt: s.status === 'connected' ? new Date() : undefined,
          lastError: s.status === 'error' ? 'Mock error' : undefined,
        }));
      },

      listTools: (serverName: string): MockToolDefinition[] => {
        const server = servers.get(serverName);
        return server?.tools || [];
      },

      callTool: async (
        serverName: string,
        toolName: string,
        params: Record<string, unknown>
      ): Promise<unknown> => {
        const server = servers.get(serverName);

        if (!server) {
          throw new Error(`Server not found: ${serverName}`);
        }

        if (server.status !== 'connected') {
          throw new Error(`Server not connected: ${serverName} (status: ${server.status})`);
        }

        // Simulate latency
        if (server.latencyMs) {
          await new Promise((resolve) => setTimeout(resolve, server.latencyMs));
        }

        // Simulate random errors
        if (server.errorRate && Math.random() < server.errorRate) {
          throw new Error(`Random error on ${serverName}.${toolName}`);
        }

        // Check for custom response
        const responses = server.customResponses || {};
        const handler = responses[toolName] || responses['*'];

        if (handler) {
          return handler(params);
        }

        // Default response
        return { success: true, server: serverName, tool: toolName, params };
      },

      searchTools: (
        query: string,
        limit: number = 20
      ): Array<{ server: string; tool: string; description: string }> => {
        const results: Array<{ server: string; tool: string; description: string }> = [];
        const lowerQuery = query.toLowerCase();

        for (const server of servers.values()) {
          if (server.status !== 'connected') continue;

          for (const tool of server.tools) {
            if (
              tool.name.toLowerCase().includes(lowerQuery) ||
              tool.description.toLowerCase().includes(lowerQuery)
            ) {
              results.push({
                server: server.name,
                tool: tool.name,
                description: tool.description,
              });
            }
          }
        }

        return results.slice(0, limit);
      },
    };
  }

  /**
   * Reset the factory
   */
  reset(): this {
    this.servers.clear();
    return this;
  }
}

/**
 * Create a standard test setup with common servers
 */
export function createStandardTestSetup(): BridgeHandlers {
  return new MockServerFactory()
    .addRealServers([
      { name: 'filesystem', status: 'connected' },
      { name: 'context7', status: 'connected' },
      { name: 'memory', status: 'connected' },
      { name: 'sequential-thinking', status: 'connected' },
      { name: 'github', status: 'connected' },
      { name: 'git', status: 'connected' },
    ])
    .build();
}

/**
 * Create a setup with error servers for testing error handling
 */
export function createErrorTestSetup(): BridgeHandlers {
  return new MockServerFactory()
    .addRealServer('filesystem', 'connected')
    .addErrorServer('fetch', 'Connection refused')
    .addErrorServer('taskmaster-ai', 'Server startup failed')
    .addFlakyServer('context7', 0.3) // 30% error rate
    .build();
}

/**
 * Create a setup for testing timeouts
 */
export function createTimeoutTestSetup(): BridgeHandlers {
  return new MockServerFactory()
    .addRealServer('filesystem', 'connected')
    .addSlowServer('slow-server', 5000) // 5 second delay
    .build();
}
