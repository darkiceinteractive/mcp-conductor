/**
 * MCP Conductor E2E Scenarios
 *
 * Comprehensive end-to-end tests covering all 20 scenarios from the test plan.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MockServerFactory,
  createStandardTestSetup,
  createErrorTestSetup,
  createTimeoutTestSetup,
  type BridgeHandlers,
} from '../../fixtures/mock-servers/index.js';
import {
  getAllSamples,
  getSampleByName,
  errorHandlingSamples,
  streamingSamples,
} from '../../fixtures/code-samples/index.js';
import { generateTestData, measureTime, expectToReject } from '../../helpers/test-utils.js';
import { calculateTokenSavings, estimateByDataSize } from '../../helpers/token-counter.js';
import {
  createMockExecutor,
  predictOptimalMode,
  validateHybridDecision,
} from '../../helpers/mode-comparator.js';

// =============================================================================
// BASIC EXECUTION (Scenarios 1-3)
// =============================================================================

describe('E2E: Basic Execution', () => {
  let handlers: BridgeHandlers;

  beforeEach(() => {
    handlers = createStandardTestSetup();
  });

  describe('Scenario 1: Simple Single-Server', () => {
    it('should execute filesystem list_directory', async () => {
      // Get tools from filesystem server
      const tools = handlers.listTools('filesystem');
      expect(tools).toContainEqual(
        expect.objectContaining({ name: 'list_directory' })
      );

      // Call the tool
      const result = await handlers.callTool('filesystem', 'list_directory', {
        path: '/test',
      });

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).toContain('[DIR]');
    });

    it('should handle filesystem read_file', async () => {
      const result = await handlers.callTool('filesystem', 'read_file', {
        path: '/test/file.ts',
      });

      expect(result).toHaveProperty('content');
      expect(typeof (result as { content: string }).content).toBe('string');
    });
  });

  describe('Scenario 2: Multi-Server Aggregation', () => {
    it('should aggregate data from context7 and memory', async () => {
      // Call context7
      const libResult = await handlers.callTool('context7', 'resolve-library-id', {
        libraryName: 'react',
      });
      expect(libResult).toHaveProperty('libraryId');

      // Call memory
      const memoryResult = await handlers.callTool('memory', 'list_projects', {});
      expect(memoryResult).toHaveProperty('projects');

      // Aggregate results
      const aggregated = {
        library: (libResult as { name: string }).name,
        projectCount: ((memoryResult as { projects: string[] }).projects || []).length,
      };

      expect(aggregated.library).toBe('react');
      expect(aggregated.projectCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Scenario 3: Data Transformation', () => {
    it('should filter and transform data in sandbox', async () => {
      // Get directory listing
      const dirResult = await handlers.callTool('filesystem', 'list_directory', {
        path: '/src',
      });

      // Transform: extract only TypeScript files
      const lines = typeof dirResult === 'string' ? dirResult.split('\n') : [];
      const tsFiles = lines
        .filter((l: string) => l.includes('.ts'))
        .map((l: string) => l.replace('[FILE] ', '').trim());

      expect(Array.isArray(tsFiles)).toBe(true);
    });

    it('should extract and summarise JSON data', async () => {
      const fileResult = await handlers.callTool('filesystem', 'read_file', {
        path: '/test/package.json',
      });

      // Parse and extract
      const content = (fileResult as { content: string }).content;
      expect(content).toBeDefined();

      // Simulate JSON extraction
      const extracted = {
        hasContent: content.length > 0,
        lineCount: content.split('\n').length,
      };

      expect(extracted.hasContent).toBe(true);
    });
  });
});

// =============================================================================
// PASSTHROUGH MODE (Scenarios 4-5)
// =============================================================================

describe('E2E: Passthrough Mode', () => {
  let handlers: BridgeHandlers;

  beforeEach(() => {
    handlers = createStandardTestSetup();
  });

  describe('Scenario 4: Direct Tool Call', () => {
    it('should make direct passthrough call', async () => {
      // Simulates passthrough_call API behaviour
      const result = await handlers.callTool('filesystem', 'get_file_info', {
        path: '/test/file.ts',
      });

      expect(result).toHaveProperty('path');
      expect(result).toHaveProperty('size');
    });

    it('should return unprocessed tool response', async () => {
      const result = await handlers.callTool('git', 'status', {});

      // Git returns text format in passthrough
      expect(typeof result).toBe('string');
      expect(result).toContain('branch');
    });
  });

  describe('Scenario 5: Mode Comparison', () => {
    it('should compare modes for simple task', async () => {
      const criteria = {
        toolCalls: 1,
        estimatedDataKb: 0.5,
        hasDataProcessing: false,
        hasMultiServerCalls: false,
        expectedDurationMs: 50,
      };

      const prediction = predictOptimalMode(criteria);

      expect(prediction.mode).toBe('passthrough');
      expect(prediction.confidence).toBeGreaterThan(0.8);
    });

    it('should compare modes for complex task', async () => {
      const criteria = {
        toolCalls: 5,
        estimatedDataKb: 30,
        hasDataProcessing: true,
        hasMultiServerCalls: true,
        expectedDurationMs: 1000,
      };

      const prediction = predictOptimalMode(criteria);

      expect(prediction.mode).toBe('execution');
      expect(prediction.confidence).toBeGreaterThan(0.8);
    });
  });
});

// =============================================================================
// HYBRID MODE (Scenarios 6-7)
// =============================================================================

describe('E2E: Hybrid Mode', () => {
  describe('Scenario 6: Simple Task Auto-Select', () => {
    it('should auto-select passthrough for simple task', () => {
      const simpleCode = `
        const fs = mcp.server('filesystem');
        return await fs.call('get_file_info', { path: '/test' });
      `;

      const criteria = {
        toolCalls: 1,
        estimatedDataKb: 0.5,
        hasDataProcessing: false,
        hasMultiServerCalls: false,
        expectedDurationMs: 50,
      };

      const prediction = predictOptimalMode(criteria);
      const validation = validateHybridDecision('passthrough', prediction.mode, criteria);

      expect(validation.correct).toBe(true);
    });
  });

  describe('Scenario 7: Complex Task Auto-Select', () => {
    it('should auto-select execution for complex task', () => {
      const complexCode = `
        const fs = mcp.server('filesystem');
        const ctx = mcp.server('context7');

        const files = await fs.call('list_directory', { path: '.' });
        const docs = await ctx.call('get-library-docs', { libraryId: '/test' });

        return files.filter(f => f.includes('.ts')).map(f => ({ file: f, docs }));
      `;

      const criteria = {
        toolCalls: 2,
        estimatedDataKb: 15,
        hasDataProcessing: true,
        hasMultiServerCalls: true,
        expectedDurationMs: 500,
      };

      const prediction = predictOptimalMode(criteria);
      const validation = validateHybridDecision('execution', prediction.mode, criteria);

      expect(prediction.mode).toBe('execution');
      expect(validation.correct).toBe(true);
    });
  });
});

// =============================================================================
// MCP SERVER TESTS (Scenarios 8-13)
// =============================================================================

describe('E2E: MCP Server Tests', () => {
  let handlers: BridgeHandlers;

  beforeEach(() => {
    handlers = createStandardTestSetup();
  });

  describe('Scenario 8: Context7', () => {
    it('should complete documentation lookup workflow', async () => {
      // Step 1: Resolve library ID
      const lib = await handlers.callTool('context7', 'resolve-library-id', {
        libraryName: 'react',
      });
      expect(lib).toHaveProperty('libraryId');

      // Step 2: Get documentation
      const docs = await handlers.callTool('context7', 'get-library-docs', {
        context7CompatibleLibraryID: (lib as { libraryId: string }).libraryId,
        topic: 'hooks',
      });
      expect(docs).toHaveProperty('content');
    });
  });

  describe('Scenario 9: Memory', () => {
    it('should perform knowledge graph CRUD', async () => {
      // Read
      const readResult = await handlers.callTool('memory', 'memory_bank_read', {
        key: 'test-key',
      });
      expect(readResult).toHaveProperty('content');

      // Write
      const writeResult = await handlers.callTool('memory', 'memory_bank_write', {
        key: 'new-key',
        value: 'test-value',
      });
      expect(writeResult).toHaveProperty('success');

      // Update
      const updateResult = await handlers.callTool('memory', 'memory_bank_update', {
        key: 'new-key',
        value: 'updated-value',
      });
      expect(updateResult).toHaveProperty('success');

      // List
      const listResult = await handlers.callTool('memory', 'list_projects', {});
      expect(listResult).toHaveProperty('projects');
    });
  });

  describe('Scenario 10: Filesystem', () => {
    it('should handle text format responses', async () => {
      const result = await handlers.callTool('filesystem', 'list_directory', {
        path: '/test',
      });

      // Filesystem returns text with [DIR]/[FILE] prefixes
      expect(typeof result).toBe('string');
      const lines = (result as string).split('\n');
      expect(lines.some((l: string) => l.startsWith('[DIR]') || l.startsWith('[FILE]'))).toBe(true);
    });

    it('should handle object responses for read_file', async () => {
      const result = await handlers.callTool('filesystem', 'read_file', {
        path: '/test/file.ts',
      });

      // read_file returns object with content property
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('content');
    });
  });

  describe('Scenario 11: GitHub', () => {
    it('should list commits and search code', async () => {
      const commits = await handlers.callTool('github', 'list_commits', {
        owner: 'test',
        repo: 'repo',
      });
      expect(commits).toHaveProperty('commits');
      expect(Array.isArray((commits as { commits: unknown[] }).commits)).toBe(true);

      const searchResult = await handlers.callTool('github', 'search_code', {
        q: 'function test',
      });
      expect(searchResult).toHaveProperty('items');
    });
  });

  describe('Scenario 12: Git', () => {
    it('should return text output for git commands', async () => {
      const status = await handlers.callTool('git', 'status', {});
      expect(typeof status).toBe('string');

      const log = await handlers.callTool('git', 'log', {});
      expect(typeof log).toBe('string');

      const diff = await handlers.callTool('git', 'diff', {});
      expect(typeof diff).toBe('string');
    });
  });

  describe('Scenario 13: Sequential-Thinking', () => {
    it('should require thoughtNumber parameter', async () => {
      // Without thoughtNumber - should fail
      await expect(
        handlers.callTool('sequential-thinking', 'sequentialthinking', {
          thought: 'Test thought',
        })
      ).rejects.toThrow('thoughtNumber');
    });

    it('should process sequential thoughts correctly', async () => {
      const result = await handlers.callTool('sequential-thinking', 'sequentialthinking', {
        thought: 'First thought',
        thoughtNumber: 1,
        totalThoughts: 3,
        nextThoughtNeeded: true,
      });

      expect(result).toHaveProperty('thoughtNumber');
      expect(result).toHaveProperty('nextThoughtNeeded');
    });
  });
});

// =============================================================================
// ERROR HANDLING (Scenarios 14-15)
// =============================================================================

describe('E2E: Error Handling', () => {
  describe('Scenario 14: Graceful Error Recovery', () => {
    let handlers: BridgeHandlers;

    beforeEach(() => {
      handlers = createErrorTestSetup();
    });

    it('should handle server in error state gracefully', async () => {
      const servers = handlers.listServers();
      const fetchServer = servers.find((s) => s.name === 'fetch');

      expect(fetchServer?.status).toBe('error');

      // Attempting to call should throw
      await expect(handlers.callTool('fetch', 'fetch', { url: 'http://test.com' })).rejects.toThrow(
        'not connected'
      );
    });

    it('should allow fallback when server unavailable', async () => {
      let result;

      try {
        result = await handlers.callTool('fetch', 'fetch', { url: 'http://api.example.com' });
      } catch {
        // Fallback to cached data
        result = { cached: true, data: 'fallback response' };
      }

      expect(result).toHaveProperty('cached');
    });

    it('should skip unavailable servers in aggregation', async () => {
      const results: Array<{ server: string; success: boolean; data?: unknown }> = [];

      // Try multiple servers, some may fail
      const serversToTry = ['filesystem', 'fetch', 'context7'];

      for (const serverName of serversToTry) {
        try {
          const server = handlers.listServers().find((s) => s.name === serverName);
          if (server?.status !== 'connected') {
            results.push({ server: serverName, success: false });
            continue;
          }

          const data = await handlers.callTool(serverName, 'list_directory', { path: '.' });
          results.push({ server: serverName, success: true, data });
        } catch {
          results.push({ server: serverName, success: false });
        }
      }

      // At least filesystem should succeed
      expect(results.some((r) => r.success)).toBe(true);
    });
  });

  describe('Scenario 15: Timeout Handling', () => {
    let handlers: BridgeHandlers;

    beforeEach(() => {
      handlers = createTimeoutTestSetup();
    });

    it('should handle slow operations with timeout', async () => {
      const TIMEOUT_MS = 100;

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
      );

      // slow-server has 5000ms latency
      const operationPromise = handlers.callTool('slow-server', 'default_tool', {});

      await expect(Promise.race([operationPromise, timeoutPromise])).rejects.toThrow('Timeout');
    });
  });
});

// =============================================================================
// ADVANCED (Scenarios 16-20)
// =============================================================================

describe('E2E: Advanced Scenarios', () => {
  let handlers: BridgeHandlers;

  beforeEach(() => {
    handlers = createStandardTestSetup();
  });

  describe('Scenario 16: Parallel Tool Calls', () => {
    it('should execute Promise.all correctly', async () => {
      const { result, durationMs } = await measureTime(async () => {
        return Promise.all([
          handlers.callTool('filesystem', 'list_directory', { path: '/src' }),
          handlers.callTool('context7', 'resolve-library-id', { libraryName: 'react' }),
          handlers.callTool('memory', 'list_projects', {}),
        ]);
      });

      expect(result).toHaveLength(3);
      expect(result[0]).toBeDefined();
      expect(result[1]).toHaveProperty('libraryId');
      expect(result[2]).toHaveProperty('projects');
    });

    it('should handle Promise.allSettled for mixed results', async () => {
      const errorHandlers = createErrorTestSetup();

      const results = await Promise.allSettled([
        errorHandlers.callTool('filesystem', 'list_directory', { path: '.' }),
        errorHandlers.callTool('fetch', 'fetch', { url: 'http://test.com' }), // Will fail
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
    });
  });

  describe('Scenario 17: Metrics Validation', () => {
    it('should track tool call counts', async () => {
      let toolCallCount = 0;

      // Instrument calls
      const originalCallTool = handlers.callTool.bind(handlers);
      handlers.callTool = async (server, tool, params) => {
        toolCallCount++;
        return originalCallTool(server, tool, params);
      };

      // Make several calls
      await handlers.callTool('filesystem', 'list_directory', { path: '.' });
      await handlers.callTool('context7', 'resolve-library-id', { libraryName: 'test' });
      await handlers.callTool('memory', 'list_projects', {});

      expect(toolCallCount).toBe(3);
    });

    it('should estimate token savings accurately', () => {
      const testCases = [
        { sizeKb: 0.5, expectedRange: [0, 30] },
        { sizeKb: 5, expectedRange: [50, 70] },
        { sizeKb: 30, expectedRange: [80, 90] },
        { sizeKb: 100, expectedRange: [95, 98] },
      ];

      for (const { sizeKb, expectedRange } of testCases) {
        const estimate = estimateByDataSize(sizeKb, 3);

        expect(estimate.expectedSavingsRange[0]).toBe(expectedRange[0]);
        expect(estimate.expectedSavingsRange[1]).toBe(expectedRange[1]);
      }
    });
  });

  describe('Scenario 18: Hot Reload', () => {
    it('should handle server list changes', () => {
      const factory = new MockServerFactory()
        .addRealServer('filesystem')
        .addRealServer('context7');

      let handlers = factory.build();

      // Initial state
      expect(handlers.listServers()).toHaveLength(2);

      // Simulate reload with new server
      factory.addRealServer('memory');
      handlers = factory.build();

      expect(handlers.listServers()).toHaveLength(3);
      expect(handlers.listServers().map((s) => s.name)).toContain('memory');
    });

    it('should handle server removal on reload', () => {
      const factory = new MockServerFactory()
        .addRealServer('filesystem')
        .addRealServer('context7')
        .addRealServer('memory');

      let handlers = factory.build();
      expect(handlers.listServers()).toHaveLength(3);

      // Simulate reload with server removed
      factory.reset().addRealServer('filesystem').addRealServer('context7');

      handlers = factory.build();
      expect(handlers.listServers()).toHaveLength(2);
      expect(handlers.listServers().map((s) => s.name)).not.toContain('memory');
    });
  });

  describe('Scenario 19: Progress Streaming', () => {
    it('should support progress callback pattern', async () => {
      const progressUpdates: string[] = [];

      const mockProgress = (message: string) => {
        progressUpdates.push(message);
      };

      // Simulate streaming operation with progress
      const files = ['file1.ts', 'file2.ts', 'file3.ts'];

      for (let i = 0; i < files.length; i++) {
        mockProgress(`Processing ${i + 1}/${files.length}: ${files[i]}`);
        await handlers.callTool('filesystem', 'read_file', { path: files[i] });
      }

      expect(progressUpdates).toHaveLength(3);
      expect(progressUpdates[0]).toContain('1/3');
      expect(progressUpdates[2]).toContain('3/3');
    });
  });

  describe('Scenario 20: Sandbox Security', () => {
    it('should isolate server access', () => {
      // Each server should only access its own tools
      const filesystemTools = handlers.listTools('filesystem');
      const context7Tools = handlers.listTools('context7');

      // Tools should be server-specific
      expect(filesystemTools.map((t) => t.name)).toContain('list_directory');
      expect(filesystemTools.map((t) => t.name)).not.toContain('resolve-library-id');

      expect(context7Tools.map((t) => t.name)).toContain('resolve-library-id');
      expect(context7Tools.map((t) => t.name)).not.toContain('list_directory');
    });

    it('should reject calls to non-existent servers', async () => {
      await expect(
        handlers.callTool('nonexistent-server', 'some_tool', {})
      ).rejects.toThrow('not found');
    });

    it('should enforce permission boundaries', async () => {
      // Connected server should work
      const result = await handlers.callTool('filesystem', 'list_directory', { path: '.' });
      expect(result).toBeDefined();

      // Error server should be rejected
      const errorHandlers = createErrorTestSetup();
      await expect(
        errorHandlers.callTool('fetch', 'fetch', { url: 'http://test.com' })
      ).rejects.toThrow();
    });
  });
});

// =============================================================================
// RESPONSE FORMAT HANDLING
// =============================================================================

describe('E2E: Response Format Handling', () => {
  let handlers: BridgeHandlers;

  beforeEach(() => {
    handlers = createStandardTestSetup();
  });

  it('should handle filesystem text format with prefixes', async () => {
    const result = await handlers.callTool('filesystem', 'list_directory', {
      path: '/test',
    });

    // Parse text format
    const lines = typeof result === 'string' ? result.split('\n') : [];
    const dirs = lines.filter((l: string) => l.startsWith('[DIR]'));
    const files = lines.filter((l: string) => l.startsWith('[FILE]'));

    expect(dirs.length + files.length).toBeGreaterThan(0);
  });

  it('should handle filesystem read_file object format', async () => {
    const result = await handlers.callTool('filesystem', 'read_file', {
      path: '/test/file.ts',
    });

    // Access content property
    const content = (result as { content: string }).content;
    expect(typeof content).toBe('string');
  });

  it('should handle context7 structured JSON', async () => {
    const result = await handlers.callTool('context7', 'resolve-library-id', {
      libraryName: 'typescript',
    });

    expect(result).toHaveProperty('libraryId');
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('description');
  });

  it('should handle memory graph structure', async () => {
    const result = await handlers.callTool('memory', 'allpepper_memory_bank', {});

    expect(result).toHaveProperty('entities');
    expect(result).toHaveProperty('relations');
    expect(Array.isArray((result as { entities: unknown[] }).entities)).toBe(true);
  });
});
