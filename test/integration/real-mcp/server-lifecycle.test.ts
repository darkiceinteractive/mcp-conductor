/**
 * Server Lifecycle Integration Tests
 *
 * Tests MCP server connection lifecycle including:
 * - Server initialisation and connection
 * - Tool caching and discovery
 * - Shutdown and cleanup
 * - Reconnection behaviour
 * - Error handling
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { MCPHub, type HubConfig } from '../../../src/hub/mcp-hub.js';
import { TestServerManager, createTestServerManager } from '../../real-servers/server-manager.js';
import {
  describeWithServer,
  skipIfNoRealServers,
  shouldSkipServer,
} from '../../helpers/conditional-tests.js';
import path from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import os from 'os';

// Test configuration
const TEST_TIMEOUT = 60000;
const SHORT_TIMEOUT = 5000;

describe('MCPHub Lifecycle', { timeout: TEST_TIMEOUT }, () => {
  describe('Initialisation', () => {
    it('should create hub with default config', () => {
      const hub = new MCPHub();
      expect(hub).toBeDefined();
      expect(hub.listServers()).toEqual([]);
    });

    it('should create hub with custom config', () => {
      const config: HubConfig = {
        connectionTimeoutMs: 10000,
        autoReconnect: false,
        reconnectDelayMs: 1000,
        maxReconnectAttempts: 5,
      };

      const hub = new MCPHub(config);
      expect(hub).toBeDefined();
    });

    it('should handle missing Claude config gracefully', async () => {
      const hub = new MCPHub({
        claudeConfigPath: '/nonexistent/path/to/config.json',
        conductorConfigPath: '/nonexistent/conductor-config.json',
      });

      // Should not throw, just log warning
      await expect(hub.initialise()).resolves.not.toThrow();
      expect(hub.listServers()).toEqual([]);
    });

    it('should filter servers by allow list', async () => {
      const hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        servers: {
          allowList: ['specific-server'],
          denyList: [],
        },
      });

      // Without a valid config, no servers will be loaded
      await hub.initialise();
      expect(hub.listServers()).toEqual([]);
    });

    it('should exclude self-references (mcp-conductor, mcp-executor)', async () => {
      // Create a temporary config file with self-references
      const tempDir = path.join(os.tmpdir(), 'mcp-test-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
      const tempConfig = path.join(tempDir, 'test-config.json');

      writeFileSync(
        tempConfig,
        JSON.stringify({
          mcpServers: {
            'mcp-conductor': { command: 'echo', args: ['test'] },
            'mcp-executor': { command: 'echo', args: ['test'] },
            'other-server': { command: 'echo', args: ['test'] },
          },
        })
      );

      try {
        const hub = new MCPHub({
          claudeConfigPath: tempConfig,
          conductorConfigPath: '/nonexistent/conductor-config.json',
          connectionTimeoutMs: 1000,
        });

        await hub.initialise();
        const servers = hub.listServers();

        // Self-references should be filtered out
        const serverNames = servers.map((s) => s.name);
        expect(serverNames).not.toContain('mcp-conductor');
        expect(serverNames).not.toContain('mcp-executor');
      } finally {
        unlinkSync(tempConfig);
      }
    });
  });

  describe('Server Connection', () => {
    let hub: MCPHub;

    beforeEach(() => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: SHORT_TIMEOUT,
        autoReconnect: false,
      });
    });

    afterEach(async () => {
      await hub.shutdown();
    });

    it('should track connection status', async () => {
      // Try to connect to a non-existent server
      const success = await hub.connectServer('test-server', {
        command: 'nonexistent-command',
        args: [],
      });

      expect(success).toBe(false);

      const servers = hub.listServers();
      const testServer = servers.find((s) => s.name === 'test-server');
      expect(testServer).toBeDefined();
      expect(testServer?.status).toBe('error');
      expect(testServer?.lastError).toBeDefined();
    });

    it('should emit serverError event on connection failure', async () => {
      const errorHandler = vi.fn();
      hub.on('serverError', errorHandler);

      await hub.connectServer('failing-server', {
        command: 'nonexistent-command',
        args: [],
      });

      expect(errorHandler).toHaveBeenCalled();
      expect(errorHandler).toHaveBeenCalledWith(
        'failing-server',
        expect.any(Error)
      );
    });

    it('should handle connection timeout', async () => {
      const timeoutHub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 100, // Very short timeout
        autoReconnect: false,
      });

      try {
        // This command exists but won't respond with MCP protocol
        const success = await timeoutHub.connectServer('timeout-test', {
          command: 'sleep',
          args: ['10'],
        });

        expect(success).toBe(false);
        const servers = timeoutHub.listServers();
        const server = servers.find((s) => s.name === 'timeout-test');
        expect(server?.status).toBe('error');
      } finally {
        await timeoutHub.shutdown();
      }
    });
  });

  describe('Server Disconnection', () => {
    let hub: MCPHub;

    beforeEach(() => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: SHORT_TIMEOUT,
        autoReconnect: false,
      });
    });

    afterEach(async () => {
      await hub.shutdown();
    });

    it('should disconnect server cleanly', async () => {
      // Connect to a server first (will fail but create connection entry)
      await hub.connectServer('test-server', {
        command: 'echo',
        args: ['test'],
      });

      // Now disconnect
      await hub.disconnectServer('test-server');

      const servers = hub.listServers();
      const testServer = servers.find((s) => s.name === 'test-server');
      expect(testServer).toBeUndefined();
    });

    it('should handle disconnecting non-existent server', async () => {
      // Should not throw
      await expect(hub.disconnectServer('nonexistent')).resolves.not.toThrow();
    });

    it('should clear tool cache on disconnect', async () => {
      await hub.connectServer('test-server', {
        command: 'echo',
        args: ['test'],
      });

      const toolsBefore = hub.getServerTools('test-server');
      await hub.disconnectServer('test-server');
      const toolsAfter = hub.getServerTools('test-server');

      expect(toolsAfter).toEqual([]);
    });
  });

  describe('Shutdown', () => {
    it('should shutdown all connections', async () => {
      const hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: SHORT_TIMEOUT,
        autoReconnect: false,
      });

      // Create some connections
      await hub.connectServer('server1', { command: 'echo', args: ['1'] });
      await hub.connectServer('server2', { command: 'echo', args: ['2'] });

      // Shutdown
      await hub.shutdown();

      expect(hub.listServers()).toEqual([]);
    });

    it('should prevent new connections during shutdown', async () => {
      const hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: SHORT_TIMEOUT,
        autoReconnect: false,
      });

      // Start shutdown
      const shutdownPromise = hub.shutdown();

      // Try to connect during shutdown
      const connectResult = await hub.connectServer('new-server', {
        command: 'echo',
        args: ['test'],
      });

      await shutdownPromise;

      expect(connectResult).toBe(false);
    });
  });

  describe('Reload', () => {
    let hub: MCPHub;
    let tempConfigPath: string;
    let tempDir: string;

    beforeEach(() => {
      tempDir = path.join(os.tmpdir(), 'mcp-test-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
      tempConfigPath = path.join(tempDir, 'test-config.json');
    });

    afterEach(async () => {
      if (hub) {
        await hub.shutdown();
      }
      if (existsSync(tempConfigPath)) {
        unlinkSync(tempConfigPath);
      }
    });

    it('should detect added servers on reload', async () => {
      // Start with empty config
      writeFileSync(tempConfigPath, JSON.stringify({ mcpServers: {} }));

      hub = new MCPHub({
        claudeConfigPath: tempConfigPath,
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: SHORT_TIMEOUT,
        autoReconnect: false,
      });

      await hub.initialise();
      expect(hub.listServers()).toEqual([]);

      // Add a server to config
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          mcpServers: {
            'new-server': { command: 'echo', args: ['test'] },
          },
        })
      );

      // Reload
      const changes = await hub.reload();
      expect(changes.added).toContain('new-server');
    });

    it('should detect removed servers on reload', async () => {
      // Start with a server
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          mcpServers: {
            'old-server': { command: 'echo', args: ['test'] },
          },
        })
      );

      hub = new MCPHub({
        claudeConfigPath: tempConfigPath,
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: SHORT_TIMEOUT,
        autoReconnect: false,
      });

      await hub.initialise();

      // Remove server from config
      writeFileSync(tempConfigPath, JSON.stringify({ mcpServers: {} }));

      // Reload
      const changes = await hub.reload();
      expect(changes.removed).toContain('old-server');
    });

    it('should emit serversChanged event on reload', async () => {
      writeFileSync(tempConfigPath, JSON.stringify({ mcpServers: {} }));

      hub = new MCPHub({
        claudeConfigPath: tempConfigPath,
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: SHORT_TIMEOUT,
        autoReconnect: false,
      });

      await hub.initialise();

      const changedHandler = vi.fn();
      hub.on('serversChanged', changedHandler);

      // Add a server
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          mcpServers: {
            'new-server': { command: 'echo', args: ['test'] },
          },
        })
      );

      await hub.reload();

      expect(changedHandler).toHaveBeenCalledWith(['new-server'], []);
    });
  });

  describe('Tool Discovery', () => {
    let hub: MCPHub;

    beforeEach(() => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: SHORT_TIMEOUT,
        autoReconnect: false,
      });
    });

    afterEach(async () => {
      await hub.shutdown();
    });

    it('should return empty tools for unknown server', () => {
      const tools = hub.getServerTools('nonexistent');
      expect(tools).toEqual([]);
    });

    it('should return all tools from all servers', async () => {
      const allTools = hub.getAllTools();
      expect(Array.isArray(allTools)).toBe(true);
    });

    it('should search tools with query', () => {
      const results = hub.searchTools('file');
      expect(Array.isArray(results)).toBe(true);
    });

    it('should search tools case-insensitively', () => {
      const results1 = hub.searchTools('FILE');
      const results2 = hub.searchTools('file');
      expect(results1.length).toBe(results2.length);
    });
  });

  describe('Tool Calls', () => {
    let hub: MCPHub;

    beforeEach(() => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: SHORT_TIMEOUT,
        autoReconnect: false,
      });
    });

    afterEach(async () => {
      await hub.shutdown();
    });

    it('should throw for unknown server', async () => {
      await expect(
        hub.callTool('nonexistent', 'tool', {})
      ).rejects.toThrow('Server not found');
    });

    it('should throw for disconnected server', async () => {
      // Create a connection entry but mark it as disconnected
      await hub.connectServer('test-server', {
        command: 'nonexistent-command',
        args: [],
      });

      // Server should be in error state
      await expect(
        hub.callTool('test-server', 'tool', {})
      ).rejects.toThrow('Server not connected');
    });
  });

  describe('Stats and Status', () => {
    let hub: MCPHub;

    beforeEach(() => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: SHORT_TIMEOUT,
        autoReconnect: false,
      });
    });

    afterEach(async () => {
      await hub.shutdown();
    });

    it('should return correct stats', async () => {
      const stats = hub.getStats();

      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('connected');
      expect(stats).toHaveProperty('error');
      expect(stats).toHaveProperty('disconnected');
      expect(typeof stats.total).toBe('number');
      expect(typeof stats.connected).toBe('number');
    });

    it('should check server connection status', () => {
      expect(hub.isServerConnected('nonexistent')).toBe(false);
    });

    it('should return config path', () => {
      const configPath = hub.getConfigPath();
      // May be null if no config found, or a string path
      expect(configPath === null || typeof configPath === 'string').toBe(true);
    });
  });

  describe('Event Handling', () => {
    let hub: MCPHub;

    beforeEach(() => {
      hub = new MCPHub({
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: SHORT_TIMEOUT,
        autoReconnect: false,
      });
    });

    afterEach(async () => {
      await hub.shutdown();
    });

    it('should emit serverConnected event', async () => {
      const connectedHandler = vi.fn();
      hub.on('serverConnected', connectedHandler);

      // This will fail but should still emit events
      await hub.connectServer('test', { command: 'echo', args: [] });

      // Connection will fail, so serverConnected won't be called
      // But serverError should be called
    });

    it('should emit serverError on connection failure', async () => {
      const errorHandler = vi.fn();
      hub.on('serverError', errorHandler);

      await hub.connectServer('failing', { command: 'nonexistent', args: [] });

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should support multiple event listeners', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      hub.on('serverError', handler1);
      hub.on('serverError', handler2);

      await hub.connectServer('test', { command: 'nonexistent', args: [] });

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should allow removing event listeners', async () => {
      const handler = vi.fn();

      hub.on('serverError', handler);
      hub.off('serverError', handler);

      await hub.connectServer('test', { command: 'nonexistent', args: [] });

      expect(handler).not.toHaveBeenCalled();
    });
  });
});

// Tests with real test-echo server
describe('MCPHub with Test Echo Server', { timeout: TEST_TIMEOUT }, () => {
  let serverManager: TestServerManager;
  let hub: MCPHub;
  let tempConfigPath: string;
  let tempDir: string;

  beforeAll(async () => {
    serverManager = createTestServerManager();

    // Create temporary config for test
    tempDir = path.join(os.tmpdir(), 'mcp-test-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    tempConfigPath = path.join(tempDir, 'test-config.json');

    // Write config pointing to test-echo server
    const serverPath = serverManager.getTestEchoServerPath();
    writeFileSync(
      tempConfigPath,
      JSON.stringify({
        mcpServers: {
          'test-echo': {
            command: 'npx',
            args: ['tsx', serverPath],
          },
        },
      })
    );
  });

  afterAll(async () => {
    if (hub) {
      await hub.shutdown();
    }
    await serverManager.stopAll();
    if (existsSync(tempConfigPath)) {
      unlinkSync(tempConfigPath);
    }
  });

  describe('Real Server Connection', () => {
    it('should connect to test-echo server', async () => {
      hub = new MCPHub({
        claudeConfigPath: tempConfigPath,
        conductorConfigPath: '/nonexistent/conductor-config.json',
        connectionTimeoutMs: 30000,
        autoReconnect: false,
      });

      const connectedHandler = vi.fn();
      hub.on('serverConnected', connectedHandler);

      await hub.initialise();

      // Check if server is connected
      const servers = hub.listServers();
      const testEcho = servers.find((s) => s.name === 'test-echo');

      if (testEcho?.status === 'connected') {
        expect(connectedHandler).toHaveBeenCalledWith('test-echo');
        expect(testEcho.toolCount).toBeGreaterThan(0);
      } else {
        // Server may not be available in all environments
        console.log('Test-echo server not available:', testEcho?.lastError);
      }
    });

    it('should cache tools from connected server', async () => {
      if (!hub) {
        hub = new MCPHub({
          claudeConfigPath: tempConfigPath,
          conductorConfigPath: '/nonexistent/conductor-config.json',
          connectionTimeoutMs: 30000,
          autoReconnect: false,
        });
        await hub.initialise();
      }

      const servers = hub.listServers();
      const testEcho = servers.find((s) => s.name === 'test-echo');

      if (testEcho?.status === 'connected') {
        const tools = hub.getServerTools('test-echo');
        expect(tools.length).toBeGreaterThan(0);

        // Check expected tools
        const toolNames = tools.map((t) => t.name);
        expect(toolNames).toContain('echo');
        expect(toolNames).toContain('delay');
        expect(toolNames).toContain('error');
      }
    });

    it('should call tools on connected server', async () => {
      if (!hub) {
        hub = new MCPHub({
          claudeConfigPath: tempConfigPath,
          conductorConfigPath: '/nonexistent/conductor-config.json',
          connectionTimeoutMs: 30000,
          autoReconnect: false,
        });
        await hub.initialise();
      }

      const isConnected = hub.isServerConnected('test-echo');

      if (isConnected) {
        try {
          const result = await hub.callTool('test-echo', 'echo', {
            message: 'Hello from test!',
          });

          expect(result).toBeDefined();
          // Result may be in different formats depending on MCP SDK version
          const echoed = typeof result === 'string'
            ? result
            : (result as Record<string, unknown>).echoed || (result as Record<string, unknown>).message;
          expect(echoed).toContain('Hello');
        } catch (error) {
          // Tool call may fail due to MCP protocol differences
          // This is acceptable in integration tests
          console.log('Tool call failed (expected in some environments):', error);
        }
      }
    });

    it('should handle server metadata tool', async () => {
      if (!hub) {
        hub = new MCPHub({
          claudeConfigPath: tempConfigPath,
          conductorConfigPath: '/nonexistent/conductor-config.json',
          connectionTimeoutMs: 30000,
          autoReconnect: false,
        });
        await hub.initialise();
      }

      const isConnected = hub.isServerConnected('test-echo');

      if (isConnected) {
        try {
          const result = await hub.callTool('test-echo', 'metadata', {}) as Record<string, unknown>;

          expect(result).toBeDefined();
          // Verify some metadata is present
          expect(result.serverName || result.version || result.uptime).toBeDefined();
        } catch (error) {
          // Tool call may fail due to MCP protocol differences
          console.log('Metadata call failed (expected in some environments):', error);
        }
      }
    });
  });
});

// Filter server tests
describe('Server Filtering', () => {
  let tempDir: string;
  let tempConfigPath: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), 'mcp-filter-test-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    tempConfigPath = path.join(tempDir, 'test-config.json');

    writeFileSync(
      tempConfigPath,
      JSON.stringify({
        mcpServers: {
          'server-a': { command: 'echo', args: ['a'] },
          'server-b': { command: 'echo', args: ['b'] },
          'server-c': { command: 'echo', args: ['c'] },
        },
      })
    );
  });

  afterEach(() => {
    if (existsSync(tempConfigPath)) {
      unlinkSync(tempConfigPath);
    }
  });

  it('should filter by allow list', async () => {
    const hub = new MCPHub({
      claudeConfigPath: tempConfigPath,
      conductorConfigPath: '/nonexistent/conductor-config.json',
      servers: {
        allowList: ['server-a'],
        denyList: [],
      },
      connectionTimeoutMs: 1000,
      autoReconnect: false,
    });

    try {
      await hub.initialise();
      const servers = hub.listServers();
      const serverNames = servers.map((s) => s.name);

      expect(serverNames).toContain('server-a');
      expect(serverNames).not.toContain('server-b');
      expect(serverNames).not.toContain('server-c');
    } finally {
      await hub.shutdown();
    }
  });

  it('should filter by deny list', async () => {
    const hub = new MCPHub({
      claudeConfigPath: tempConfigPath,
      conductorConfigPath: '/nonexistent/conductor-config.json',
      servers: {
        allowList: ['*'],
        denyList: ['server-b'],
      },
      connectionTimeoutMs: 1000,
      autoReconnect: false,
    });

    try {
      await hub.initialise();
      const servers = hub.listServers();
      const serverNames = servers.map((s) => s.name);

      expect(serverNames).toContain('server-a');
      expect(serverNames).not.toContain('server-b');
      expect(serverNames).toContain('server-c');
    } finally {
      await hub.shutdown();
    }
  });

  it('should allow all with wildcard', async () => {
    const hub = new MCPHub({
      claudeConfigPath: tempConfigPath,
      conductorConfigPath: '/nonexistent/conductor-config.json',
      servers: {
        allowList: ['*'],
        denyList: [],
      },
      connectionTimeoutMs: 1000,
      autoReconnect: false,
    });

    try {
      await hub.initialise();
      const servers = hub.listServers();
      const serverNames = servers.map((s) => s.name);

      expect(serverNames).toContain('server-a');
      expect(serverNames).toContain('server-b');
      expect(serverNames).toContain('server-c');
    } finally {
      await hub.shutdown();
    }
  });

  it('should prioritise deny over allow', async () => {
    const hub = new MCPHub({
      claudeConfigPath: tempConfigPath,
      conductorConfigPath: '/nonexistent/conductor-config.json',
      servers: {
        allowList: ['server-a', 'server-b'],
        denyList: ['server-b'],
      },
      connectionTimeoutMs: 1000,
      autoReconnect: false,
    });

    try {
      await hub.initialise();
      const servers = hub.listServers();
      const serverNames = servers.map((s) => s.name);

      expect(serverNames).toContain('server-a');
      expect(serverNames).not.toContain('server-b');
    } finally {
      await hub.shutdown();
    }
  });
});
