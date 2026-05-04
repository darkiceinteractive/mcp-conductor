/**
 * Integration tests for the full MCP Executor flow.
 *
 * These tests verify the complete execution pipeline from
 * code submission through to result retrieval.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { HttpBridge, type BridgeHandlers, type ServerInfo } from '../../src/bridge/http-server.js';
import { DenoExecutor } from '../../src/runtime/executor.js';
import type { BridgeConfig, SandboxConfig } from '../../src/config/schema.js';

describe('Full Flow Integration', () => {
  let bridge: HttpBridge;
  let executor: DenoExecutor;
  let denoAvailable: boolean;

  const BRIDGE_PORT = 29847; // Different port for integration tests

  const bridgeConfig: BridgeConfig = {
    port: BRIDGE_PORT,
    // Bind explicitly to IPv4 127.0.0.1 — on some Linux CI images `localhost`
    // resolves to ::1 (IPv6), but Deno's fetch-from-sandbox uses IPv4 first,
    // which causes ECONNREFUSED despite both being "localhost".
    host: '127.0.0.1',
  };

  const sandboxConfig: SandboxConfig = {
    maxMemoryMb: 512,
    allowedNetHosts: ['localhost'],
  };

  const mockHandlers: BridgeHandlers = {
    listServers: (): ServerInfo[] => [
      { name: 'echo', toolCount: 2, status: 'connected' },
      { name: 'math', toolCount: 3, status: 'connected' },
    ],
    listTools: (serverName: string) => {
      if (serverName === 'echo') {
        return [
          { name: 'reverse', description: 'Reverse a string' },
          { name: 'uppercase', description: 'Convert to uppercase' },
        ];
      }
      if (serverName === 'math') {
        return [
          { name: 'add', description: 'Add two numbers' },
          { name: 'multiply', description: 'Multiply two numbers' },
          { name: 'factorial', description: 'Calculate factorial' },
        ];
      }
      return [];
    },
    callTool: async (
      serverName: string,
      toolName: string,
      params: Record<string, unknown>
    ) => {
      // Mock tool implementations
      if (serverName === 'echo') {
        if (toolName === 'reverse') {
          const message = String(params['message'] || '');
          return { reversed: message.split('').reverse().join('') };
        }
        if (toolName === 'uppercase') {
          const message = String(params['message'] || '');
          return { result: message.toUpperCase() };
        }
      }
      if (serverName === 'math') {
        if (toolName === 'add') {
          const a = Number(params['a'] || 0);
          const b = Number(params['b'] || 0);
          return { result: a + b };
        }
        if (toolName === 'multiply') {
          const a = Number(params['a'] || 0);
          const b = Number(params['b'] || 0);
          return { result: a * b };
        }
        if (toolName === 'factorial') {
          const n = Number(params['n'] || 0);
          let result = 1;
          for (let i = 2; i <= n; i++) result *= i;
          return { result };
        }
      }
      throw new Error(`Unknown tool: ${serverName}.${toolName}`);
    },
    searchTools: (query: string) => {
      const allTools = [
        { server: 'echo', tool: 'reverse', description: 'Reverse a string' },
        { server: 'echo', tool: 'uppercase', description: 'Convert to uppercase' },
        { server: 'math', tool: 'add', description: 'Add two numbers' },
        { server: 'math', tool: 'multiply', description: 'Multiply two numbers' },
        { server: 'math', tool: 'factorial', description: 'Calculate factorial' },
      ];
      const lowerQuery = query.toLowerCase();
      return allTools.filter(
        (t) =>
          t.tool.toLowerCase().includes(lowerQuery) ||
          t.description.toLowerCase().includes(lowerQuery)
      );
    },
  };

  beforeAll(async () => {
    // Check if Deno is available
    executor = new DenoExecutor(sandboxConfig);
    denoAvailable = await executor.checkDeno();

    if (denoAvailable) {
      // Start the bridge for integration tests
      bridge = new HttpBridge(bridgeConfig);
      bridge.setHandlers(mockHandlers);
      await bridge.start();
    }
  });

  afterAll(async () => {
    if (bridge) {
      await bridge.stop();
    }
  });

  describe('Deno sandbox with MCP bridge', () => {
    it('should execute code that calls MCP tools', async () => {
      if (!denoAvailable) {
        console.log('Skipping integration test: Deno not available');
        return;
      }

      const code = `
        const echo = mcp.server('echo');
        const result = await echo.call('reverse', { message: 'hello' });
        return result;
      `;

      const result = await executor.execute(code, {
        timeoutMs: 10000,
        bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}`,
        servers: ['echo'],
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ reversed: 'olleh' });
    });

    it('should handle multiple tool calls', async () => {
      if (!denoAvailable) {
        console.log('Skipping integration test: Deno not available');
        return;
      }

      const code = `
        const math = mcp.server('math');
        const sum = await math.call('add', { a: 10, b: 20 });
        const product = await math.call('multiply', { a: 5, b: 7 });
        return { sum: sum.result, product: product.result };
      `;

      const result = await executor.execute(code, {
        timeoutMs: 10000,
        bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}`,
        servers: ['math'],
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ sum: 30, product: 35 });
      expect(result.metrics.toolCalls).toBe(2);
    });

    it('should support attribute-style server access', async () => {
      if (!denoAvailable) {
        console.log('Skipping integration test: Deno not available');
        return;
      }

      const code = `
        const result = await mcp.echo.call('uppercase', { message: 'hello world' });
        return result;
      `;

      const result = await executor.execute(code, {
        timeoutMs: 10000,
        bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}`,
        servers: ['echo'],
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ result: 'HELLO WORLD' });
    });

    it('should capture logs during execution', async () => {
      if (!denoAvailable) {
        console.log('Skipping integration test: Deno not available');
        return;
      }

      const code = `
        console.log('Starting computation...');
        const math = mcp.server('math');
        const result = await math.call('factorial', { n: 5 });
        console.log('Factorial result:', result.result);
        return result;
      `;

      const result = await executor.execute(code, {
        timeoutMs: 10000,
        bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}`,
        servers: ['math'],
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ result: 120 });
      expect(result.logs).toContain('Starting computation...');
      expect(result.logs.some((log) => log.includes('120'))).toBe(true);
    });

    it('should handle tool errors gracefully', async () => {
      if (!denoAvailable) {
        console.log('Skipping integration test: Deno not available');
        return;
      }

      const code = `
        const unknown = mcp.server('unknown');
        try {
          await unknown.call('nonexistent', {});
          return { error: 'Should have thrown' };
        } catch (e) {
          return { caught: true, message: e.message };
        }
      `;

      const result = await executor.execute(code, {
        timeoutMs: 10000,
        bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}`,
        servers: [],
      });

      expect(result.success).toBe(true);
      expect(result.result).toHaveProperty('caught', true);
    });

    it('should aggregate data from multiple servers', async () => {
      if (!denoAvailable) {
        console.log('Skipping integration test: Deno not available');
        return;
      }

      const code = `
        const echo = mcp.server('echo');
        const math = mcp.server('math');

        // Get processed string
        const reversed = await echo.call('reverse', { message: 'test' });

        // Get calculation
        const sum = await math.call('add', { a: 100, b: 200 });

        // Combine results
        return {
          text: reversed.reversed,
          number: sum.result,
          combined: reversed.reversed + '-' + sum.result
        };
      `;

      const result = await executor.execute(code, {
        timeoutMs: 10000,
        bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}`,
        servers: ['echo', 'math'],
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual({
        text: 'tset',
        number: 300,
        combined: 'tset-300',
      });
      expect(result.metrics.toolCalls).toBe(2);
    });

    it('mcp.batch accepts callback form: [() => mcp.server(x).call(y, {})]', async () => {
      if (!denoAvailable) {
        console.log('Skipping integration test: Deno not available');
        return;
      }

      // Callback form: each element is a thunk (() => Promise<T>).
      // Results must arrive in the same order as the calls array.
      const code = `
        const results = await mcp.batch([
          () => mcp.server('echo').call('reverse', { message: 'abc' }),
          () => mcp.server('math').call('add', { a: 3, b: 7 }),
          () => mcp.server('echo').call('uppercase', { message: 'hello' }),
        ]);
        return results;
      `;

      const result = await executor.execute(code, {
        timeoutMs: 15000,
        bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}`,
        servers: ['echo', 'math'],
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual([
        { reversed: 'cba' },
        { result: 10 },
        { result: 'HELLO' },
      ]);
    });

    it('mcp.batch accepts descriptor form: [{server, tool, params}]', async () => {
      if (!denoAvailable) {
        console.log('Skipping integration test: Deno not available');
        return;
      }

      // Descriptor form: each element is { server, tool, params }.
      // Results must arrive in the same order as the descriptors array.
      const code = `
        const results = await mcp.batch([
          { server: 'math', tool: 'multiply', params: { a: 4, b: 5 } },
          { server: 'echo', tool: 'reverse',  params: { message: 'xyz' } },
          { server: 'math', tool: 'add',      params: { a: 1, b: 2 } },
        ]);
        return results;
      `;

      const result = await executor.execute(code, {
        timeoutMs: 15000,
        bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}`,
        servers: ['echo', 'math'],
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual([
        { result: 20 },
        { reversed: 'zyx' },
        { result: 3 },
      ]);
    });
  });

  describe('Bridge health and discovery', () => {
    it('should respond to health checks', async () => {
      if (!denoAvailable) {
        console.log('Skipping integration test: Deno not available');
        return;
      }

      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.serversConnected).toBe(2);
    });

    it('should list available tools', async () => {
      if (!denoAvailable) {
        console.log('Skipping integration test: Deno not available');
        return;
      }

      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/servers/math/tools`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.tools).toHaveLength(3);
      expect(data.tools.map((t: { name: string }) => t.name)).toContain('add');
    });

    it('should search tools across servers', async () => {
      if (!denoAvailable) {
        console.log('Skipping integration test: Deno not available');
        return;
      }

      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/search?q=multiply`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.results).toHaveLength(1);
      expect(data.results[0].tool).toBe('multiply');
    });
  });
});
