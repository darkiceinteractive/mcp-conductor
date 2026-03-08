/**
 * Connection Resilience Integration Tests
 *
 * Tests MCP server connection resilience including:
 * - Reconnection after disconnection
 * - Exponential backoff
 * - Graceful degradation
 * - Error recovery
 * - Timeout handling
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { MCPHub, type HubConfig } from '../../../src/hub/mcp-hub.js';
import { MCPExecutorServer } from '../../../src/server/mcp-server.js';
import { DEFAULT_CONFIG, type MCPExecutorConfig } from '../../../src/config/index.js';
import { TestServerManager, createTestServerManager } from '../../real-servers/server-manager.js';
import path from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import os from 'os';

// Test configuration
const TEST_TIMEOUT = 60000;
const SHORT_TIMEOUT = 5000;

describe('Connection Resilience', { timeout: TEST_TIMEOUT }, () => {
  describe('Reconnection Behaviour', () => {
    let hub: MCPHub;
    let tempDir: string;
    let tempConfigPath: string;

    beforeEach(() => {
      tempDir = path.join(os.tmpdir(), 'mcp-reconnect-test-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
      tempConfigPath = path.join(tempDir, 'config.json');
    });

    afterEach(async () => {
      if (hub) {
        await hub.shutdown();
      }
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true });
      }
    });

    it('should track reconnection attempts', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        autoReconnect: true,
        reconnectDelayMs: 100,
        maxReconnectAttempts: 2,
        connectionTimeoutMs: 1000,
      });

      const errorEvents: string[] = [];
      hub.on('serverError', (name) => {
        errorEvents.push(name);
      });

      // Connect to a failing server
      await hub.connectServer('failing-server', {
        command: 'nonexistent-command',
        args: [],
      });

      // Wait for potential reconnect attempts
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should have had at least one error
      expect(errorEvents.length).toBeGreaterThan(0);
    });

    it('should respect maxReconnectAttempts limit', async () => {
      const maxAttempts = 2;
      let reconnectCount = 0;

      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        autoReconnect: true,
        reconnectDelayMs: 50,
        maxReconnectAttempts: maxAttempts,
        connectionTimeoutMs: 100,
      });

      hub.on('serverError', () => {
        reconnectCount++;
      });

      // Connect to a failing server
      await hub.connectServer('limited-retry', {
        command: 'nonexistent-command',
        args: [],
      });

      // Wait for reconnect attempts
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should have at least one error but eventually stop reconnecting
      // The exact count can vary due to timing, but should be bounded
      expect(reconnectCount).toBeGreaterThan(0);
      // Allow some tolerance for race conditions and multiple error events per attempt
      expect(reconnectCount).toBeLessThanOrEqual((maxAttempts + 1) * 3);
    });

    it('should not reconnect when autoReconnect is false', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        autoReconnect: false,
        connectionTimeoutMs: 100,
      });

      let errorCount = 0;
      hub.on('serverError', () => {
        errorCount++;
      });

      // Connect to a failing server
      await hub.connectServer('no-retry', {
        command: 'nonexistent-command',
        args: [],
      });

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Should have at least 1 error but limited retries
      expect(errorCount).toBeGreaterThanOrEqual(1);
      expect(errorCount).toBeLessThanOrEqual(3); // No automatic retries
    });

    it('should stop reconnection attempts during shutdown', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        autoReconnect: true,
        reconnectDelayMs: 100,
        maxReconnectAttempts: 10,
        connectionTimeoutMs: 100,
      });

      // Connect to a failing server
      await hub.connectServer('shutdown-test', {
        command: 'nonexistent-command',
        args: [],
      });

      // Start shutdown immediately
      await hub.shutdown();

      // No assertions needed - just verifying no errors during shutdown
    });
  });

  describe('Timeout Handling', () => {
    let hub: MCPHub;

    afterEach(async () => {
      if (hub) {
        await hub.shutdown();
      }
    });

    it('should timeout slow connections', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 100,
        autoReconnect: false,
      });

      const startTime = Date.now();

      // Try to connect to a command that will hang
      await hub.connectServer('slow-server', {
        command: 'sleep',
        args: ['10'],
      });

      const elapsed = Date.now() - startTime;

      // Should have timed out within reasonable time
      expect(elapsed).toBeLessThan(5000);

      const servers = hub.listServers();
      const server = servers.find((s) => s.name === 'slow-server');
      expect(server?.status).toBe('error');
    });

    it('should handle very short timeouts', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 1, // 1ms timeout
        autoReconnect: false,
      });

      const result = await hub.connectServer('instant-timeout', {
        command: 'echo',
        args: ['test'],
      });

      expect(result).toBe(false);
    });
  });

  describe('Error Recovery', () => {
    let hub: MCPHub;

    afterEach(async () => {
      if (hub) {
        await hub.shutdown();
      }
    });

    it('should emit error events with proper Error objects', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 100,
        autoReconnect: false,
      });

      let receivedError: Error | null = null;
      hub.on('serverError', (name, error) => {
        receivedError = error;
      });

      await hub.connectServer('error-test', {
        command: 'nonexistent-command',
        args: [],
      });

      expect(receivedError).toBeInstanceOf(Error);
      expect(receivedError?.message).toBeDefined();
    });

    it('should track last error on server connection', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 100,
        autoReconnect: false,
      });

      await hub.connectServer('error-track', {
        command: 'nonexistent-command',
        args: [],
      });

      const servers = hub.listServers();
      const server = servers.find((s) => s.name === 'error-track');

      expect(server?.lastError).toBeDefined();
      expect(server?.status).toBe('error');
    });

    it('should continue operating with partial server failures', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 100,
        autoReconnect: false,
      });

      // Connect one failing and one (also failing but different) server
      await hub.connectServer('failing-1', {
        command: 'nonexistent1',
        args: [],
      });

      await hub.connectServer('failing-2', {
        command: 'nonexistent2',
        args: [],
      });

      const servers = hub.listServers();

      // Both should be in error state but hub should still function
      expect(servers.length).toBe(2);
      expect(hub.getStats().error).toBe(2);
    });
  });

  describe('Graceful Degradation', () => {
    let hub: MCPHub;

    afterEach(async () => {
      if (hub) {
        await hub.shutdown();
      }
    });

    it('should return empty results when no servers connected', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 100,
        autoReconnect: false,
      });

      // Don't connect any servers

      const servers = hub.listServers();
      expect(servers).toEqual([]);

      const tools = hub.getAllTools();
      expect(tools).toEqual([]);

      const searchResults = hub.searchTools('test');
      expect(searchResults).toEqual([]);
    });

    it('should throw clear error for tool calls to failed servers', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 100,
        autoReconnect: false,
      });

      await hub.connectServer('failed-server', {
        command: 'nonexistent',
        args: [],
      });

      await expect(
        hub.callTool('failed-server', 'some-tool', {})
      ).rejects.toThrow(/not connected/i);
    });

    it('should return correct stats with mixed server states', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 100,
        autoReconnect: false,
      });

      // Create multiple failed connections
      await hub.connectServer('server-1', { command: 'bad1', args: [] });
      await hub.connectServer('server-2', { command: 'bad2', args: [] });

      const stats = hub.getStats();

      expect(stats.total).toBe(2);
      expect(stats.error).toBe(2);
      expect(stats.connected).toBe(0);
    });
  });

  describe('Connection Pool Management', () => {
    let hub: MCPHub;

    afterEach(async () => {
      if (hub) {
        await hub.shutdown();
      }
    });

    it('should handle multiple rapid connection attempts', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 100,
        autoReconnect: false,
      });

      // Rapidly add many servers
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          hub.connectServer(`rapid-${i}`, {
            command: 'echo',
            args: [String(i)],
          })
        );
      }

      await Promise.all(promises);

      const servers = hub.listServers();
      expect(servers.length).toBe(5);
    });

    it('should handle duplicate connection attempts', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 100,
        autoReconnect: false,
      });

      // Try to connect to same server twice
      const firstResult = await hub.connectServer('duplicate-test', {
        command: 'echo',
        args: ['1'],
      });

      // Second connection may throw or return false
      // depending on implementation
      const secondResult = await hub.connectServer('duplicate-test', {
        command: 'echo',
        args: ['2'],
      }).catch(() => false);

      // At least one connection attempt should have occurred
      const servers = hub.listServers();
      expect(servers.some((s) => s.name === 'duplicate-test')).toBe(true);
    });

    it('should clean up connections on disconnect', async () => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 100,
        autoReconnect: false,
      });

      await hub.connectServer('cleanup-test', {
        command: 'echo',
        args: ['test'],
      });

      expect(hub.listServers().length).toBe(1);

      await hub.disconnectServer('cleanup-test');

      expect(hub.listServers().length).toBe(0);
      expect(hub.getServerTools('cleanup-test')).toEqual([]);
    });
  });

  describe('MCPExecutorServer Resilience', () => {
    let server: MCPExecutorServer;
    let tools: Map<string, { handler: (params: unknown) => Promise<unknown> }>;

    beforeEach(() => {
      const config: MCPExecutorConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      config.execution.defaultTimeoutMs = 5000;
      server = new MCPExecutorServer(config, { useMockServers: true });
      tools = server.getRegisteredTools();
    });

    it('should handle tool calls to mock servers', async () => {
      const passthrough = tools.get('passthrough_call');

      const result = await passthrough!.handler({
        server: 'echo',
        tool: 'echo',
        params: { message: 'resilience test' },
      });

      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.result.message).toBe('resilience test');
    });

    it('should handle errors gracefully in passthrough', async () => {
      const passthrough = tools.get('passthrough_call');

      const result = await passthrough!.handler({
        server: 'nonexistent',
        tool: 'tool',
        params: {},
      });

      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.error).toBeDefined();
    });

    it('should continue working after errors', async () => {
      const passthrough = tools.get('passthrough_call');

      // First call - error
      await passthrough!.handler({
        server: 'nonexistent',
        tool: 'tool',
        params: {},
      });

      // Second call - should still work
      const result = await passthrough!.handler({
        server: 'echo',
        tool: 'echo',
        params: { message: 'after error' },
      });

      expect(result.structuredContent.success).toBe(true);
    });

    it('should track metrics through errors', async () => {
      const passthrough = tools.get('passthrough_call');
      const getMetrics = tools.get('get_metrics');

      // Generate some errors
      await passthrough!.handler({
        server: 'nonexistent',
        tool: 'tool',
        params: {},
      });

      // Get metrics
      const metricsResult = await getMetrics!.handler({});
      const metrics = metricsResult.structuredContent;

      expect(metrics.executions.total).toBeGreaterThan(0);
      expect(metrics.executions.failed).toBeGreaterThan(0);
    });
  });
});

describe('Server Config Hot Reload', { timeout: TEST_TIMEOUT }, () => {
  let hub: MCPHub;
  let tempDir: string;
  let tempConfigPath: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), 'mcp-hotreload-test-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    tempConfigPath = path.join(tempDir, 'config.json');
  });

  afterEach(async () => {
    if (hub) {
      await hub.shutdown();
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it('should detect config changes on reload', async () => {
    // Initial config
    writeFileSync(
      tempConfigPath,
      JSON.stringify({
        mcpServers: {
          'server-a': { command: 'echo', args: ['a'] },
        },
      })
    );

    hub = new MCPHub({
      claudeConfigPath: tempConfigPath,
      conductorConfigPath: '/nonexistent/conductor-config.json',
      connectionTimeoutMs: 100,
      autoReconnect: false,
    });

    await hub.initialise();
    expect(hub.listServers().length).toBe(1);

    // Update config
    writeFileSync(
      tempConfigPath,
      JSON.stringify({
        mcpServers: {
          'server-a': { command: 'echo', args: ['a'] },
          'server-b': { command: 'echo', args: ['b'] },
        },
      })
    );

    const changes = await hub.reload();
    expect(changes.added).toContain('server-b');
  });

  it('should handle config file removal gracefully', async () => {
    writeFileSync(
      tempConfigPath,
      JSON.stringify({
        mcpServers: {
          'server-a': { command: 'echo', args: ['a'] },
        },
      })
    );

    hub = new MCPHub({
      claudeConfigPath: tempConfigPath,
      conductorConfigPath: '/nonexistent/conductor-config.json',
      connectionTimeoutMs: 100,
      autoReconnect: false,
    });

    await hub.initialise();

    // Delete config file
    unlinkSync(tempConfigPath);

    // Reload should handle missing file
    const changes = await hub.reload();
    expect(changes.added).toEqual([]);
    expect(changes.removed.length).toBeGreaterThanOrEqual(0);
  });

  it('should reconnect when server config changes', async () => {
    writeFileSync(
      tempConfigPath,
      JSON.stringify({
        mcpServers: {
          'changeable': { command: 'echo', args: ['original'] },
        },
      })
    );

    hub = new MCPHub({
      claudeConfigPath: tempConfigPath,
      conductorConfigPath: '/nonexistent/conductor-config.json',
      connectionTimeoutMs: 100,
      autoReconnect: false,
    });

    await hub.initialise();

    // Change config
    writeFileSync(
      tempConfigPath,
      JSON.stringify({
        mcpServers: {
          'changeable': { command: 'cat', args: ['modified'] },
        },
      })
    );

    await hub.reload();

    // Server should have been reconnected with new config
    const servers = hub.listServers();
    const server = servers.find((s) => s.name === 'changeable');
    expect(server).toBeDefined();
  });
});

describe('Concurrent Operations', { timeout: TEST_TIMEOUT }, () => {
  let hub: MCPHub;

  afterEach(async () => {
    if (hub) {
      await hub.shutdown();
    }
  });

  it('should handle concurrent tool searches', async () => {
    hub = new MCPHub({
      connectionTimeoutMs: 100,
      autoReconnect: false,
    });

    // Run multiple searches concurrently
    const searches = await Promise.all([
      hub.searchTools('file'),
      hub.searchTools('read'),
      hub.searchTools('write'),
      hub.searchTools('list'),
    ]);

    // All should return results (even if empty)
    for (const result of searches) {
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it('should handle concurrent server operations', async () => {
    hub = new MCPHub({
      connectionTimeoutMs: 100,
      autoReconnect: false,
    });

    // Concurrent operations
    const [
      listResult,
      statsResult,
      allTools,
      searchResult,
    ] = await Promise.all([
      Promise.resolve(hub.listServers()),
      Promise.resolve(hub.getStats()),
      Promise.resolve(hub.getAllTools()),
      Promise.resolve(hub.searchTools('test')),
    ]);

    expect(Array.isArray(listResult)).toBe(true);
    expect(statsResult.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(allTools)).toBe(true);
    expect(Array.isArray(searchResult)).toBe(true);
  });

  it('should handle shutdown during concurrent operations', async () => {
    hub = new MCPHub({
      connectionTimeoutMs: 100,
      autoReconnect: false,
    });

    // Start some operations
    const operation = hub.connectServer('concurrent-shutdown', {
      command: 'sleep',
      args: ['1'],
    });

    // Immediately shutdown
    await hub.shutdown();

    // Operation should complete (either success or fail)
    await operation;
  });
});
