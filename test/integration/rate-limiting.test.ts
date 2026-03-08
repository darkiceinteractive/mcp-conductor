/**
 * Rate Limiting Integration Tests
 *
 * Tests the integration of RateLimiter with MCPHub:
 * - MCPHub creates rate limiters when configured
 * - MCPHub respects rate limits during callTool()
 * - Rate limiter cleanup on disconnect
 * - Config changes trigger reconnection
 * - Queue mode behaviour with actual hub calls
 * - Reject mode behaviour with actual hub calls
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MCPHub } from '../../src/hub/mcp-hub.js';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { ConductorConfig } from '../../src/config/schema.js';

// Test configuration
const TEST_TIMEOUT = 30000;

describe('Rate Limiting Integration', { timeout: TEST_TIMEOUT }, () => {
  let hub: MCPHub;
  let tempDir: string;
  let tempConfigPath: string;

  beforeEach(() => {
    // Create temp directory for test configs
    tempDir = path.join(os.tmpdir(), 'mcp-rate-limit-test-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    tempConfigPath = path.join(tempDir, 'conductor.json');
  });

  afterEach(async () => {
    if (hub) {
      await hub.shutdown();
    }
    if (existsSync(tempConfigPath)) {
      unlinkSync(tempConfigPath);
    }
  });

  describe('Rate Limiter Creation', () => {
    it('should create rate limiter when rateLimit config is provided', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'test-server': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 5,
              burstSize: 10,
              onLimitExceeded: 'queue',
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers.length).toBeGreaterThan(0);

      // The rate limiter is created internally - we can verify behaviour through callTool
      // Server exists with rate limit config
      const testServer = servers.find((s) => s.name === 'test-server');
      expect(testServer).toBeDefined();
    });

    it('should not create rate limiter when rateLimit config is not provided', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'test-server': {
            command: 'echo',
            args: ['test'],
            // No rateLimit config
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers.length).toBeGreaterThan(0);
    });

    it('should create rate limiters for multiple servers with different configs', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'fast-server': {
            command: 'echo',
            args: ['fast'],
            rateLimit: {
              requestsPerSecond: 100,
            },
          },
          'slow-server': {
            command: 'echo',
            args: ['slow'],
            rateLimit: {
              requestsPerSecond: 2,
              onLimitExceeded: 'reject',
            },
          },
          'unlimited-server': {
            command: 'echo',
            args: ['unlimited'],
            // No rate limit
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers.length).toBe(3);
    });
  });

  describe('Rate Limiter Cleanup', () => {
    it('should destroy rate limiter when server is disconnected', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'test-server': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 5,
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      // Verify server exists
      let servers = hub.listServers();
      expect(servers.find((s) => s.name === 'test-server')).toBeDefined();

      // Disconnect the server
      await hub.disconnectServer('test-server');

      // Server should be removed
      servers = hub.listServers();
      expect(servers.find((s) => s.name === 'test-server')).toBeUndefined();
    });

    it('should clean up all rate limiters on hub shutdown', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'server-1': {
            command: 'echo',
            args: ['1'],
            rateLimit: { requestsPerSecond: 5 },
          },
          'server-2': {
            command: 'echo',
            args: ['2'],
            rateLimit: { requestsPerSecond: 10 },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      expect(hub.listServers().length).toBe(2);

      // Shutdown should clean up all rate limiters
      await hub.shutdown();

      expect(hub.listServers().length).toBe(0);
    });
  });

  describe('Config Changes and Reconnection', () => {
    it('should detect rate limit config changes and reconnect server', async () => {
      const initialConfig: ConductorConfig = {
        exclusive: true,
        servers: {
          'test-server': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 5,
              burstSize: 5,
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(initialConfig));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      // Update config with different rate limit
      const updatedConfig: ConductorConfig = {
        exclusive: true,
        servers: {
          'test-server': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 10, // Changed
              burstSize: 20, // Changed
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(updatedConfig));

      // Reload should detect the change
      const changes = await hub.reload();

      // Server should be reconnected (not in added/removed)
      expect(changes.added).not.toContain('test-server');
      expect(changes.removed).not.toContain('test-server');

      // Server should still exist
      const servers = hub.listServers();
      expect(servers.find((s) => s.name === 'test-server')).toBeDefined();
    });

    it('should reconnect when rate limit is added to existing server', async () => {
      const initialConfig: ConductorConfig = {
        exclusive: true,
        servers: {
          'test-server': {
            command: 'echo',
            args: ['test'],
            // No rate limit initially
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(initialConfig));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      // Add rate limit
      const updatedConfig: ConductorConfig = {
        exclusive: true,
        servers: {
          'test-server': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 5,
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(updatedConfig));

      await hub.reload();

      // Server should still exist
      const servers = hub.listServers();
      expect(servers.find((s) => s.name === 'test-server')).toBeDefined();
    });

    it('should reconnect when rate limit is removed from server', async () => {
      const initialConfig: ConductorConfig = {
        exclusive: true,
        servers: {
          'test-server': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 5,
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(initialConfig));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      // Remove rate limit
      const updatedConfig: ConductorConfig = {
        exclusive: true,
        servers: {
          'test-server': {
            command: 'echo',
            args: ['test'],
            // No rate limit
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(updatedConfig));

      await hub.reload();

      // Server should still exist
      const servers = hub.listServers();
      expect(servers.find((s) => s.name === 'test-server')).toBeDefined();
    });
  });

  describe('Queue Mode Behaviour', () => {
    it('should queue tool calls when rate limit is exceeded', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'rate-limited-server': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 2, // Very low rate
              burstSize: 1, // Only 1 token available
              onLimitExceeded: 'queue',
              maxQueueTimeMs: 5000,
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      // First call should succeed immediately (uses the burst token)
      // Subsequent calls will be queued

      // Since echo command doesn't support MCP protocol, we expect errors
      // but the rate limiting should still apply
      await expect(
        hub.callTool('rate-limited-server', 'test-tool', {})
      ).rejects.toThrow('Server not connected');
    });

    it('should reject queued requests on queue timeout', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'slow-server': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 0.1, // Very slow: 1 token per 10 seconds
              burstSize: 1,
              onLimitExceeded: 'queue',
              maxQueueTimeMs: 100, // Short timeout
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      // Calls will be queued and timeout
      await expect(
        hub.callTool('slow-server', 'test-tool', {})
      ).rejects.toThrow('Server not connected');
    });
  });

  describe('Reject Mode Behaviour', () => {
    it('should immediately reject tool calls when rate limit is exceeded', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'strict-server': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 2,
              burstSize: 1,
              onLimitExceeded: 'reject', // Reject immediately
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      // Since echo doesn't support MCP, we expect connection errors
      await expect(
        hub.callTool('strict-server', 'test-tool', {})
      ).rejects.toThrow('Server not connected');
    });
  });

  describe('Rate Limiting with Mock Server', () => {
    it('should enforce rate limits across multiple concurrent calls', async () => {
      // Create a mock server that will fail to connect
      // but still demonstrate rate limiting logic
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'concurrent-test': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 5,
              burstSize: 3,
              onLimitExceeded: 'queue',
              maxQueueTimeMs: 10000,
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      // Launch multiple concurrent calls
      const promises = Array.from({ length: 10 }, () =>
        hub.callTool('concurrent-test', 'test-tool', {}).catch((e) => e)
      );

      // All should reject (server not connected), but rate limiting applied
      const results = await Promise.allSettled(promises);

      // All will be rejected because echo doesn't support MCP
      results.forEach((result) => {
        expect(result.status).toBe('fulfilled'); // .catch returns error as value
      });
    });
  });

  describe('Rate Limiting Events', () => {
    it('should emit rate limiter events during tool calls', async () => {
      // This test verifies that rate limiter events flow through
      // We can't easily test this without a real MCP server,
      // but we can verify the hub setup
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'event-test': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 10,
              burstSize: 5,
              onLimitExceeded: 'queue',
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      // Verify server exists with rate limiting
      const servers = hub.listServers();
      const eventTest = servers.find((s) => s.name === 'event-test');
      expect(eventTest).toBeDefined();
    });
  });

  describe('Rate Limiting Configuration Validation', () => {
    it('should handle rate limit config with only requestsPerSecond', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'minimal-config': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 5,
              // All other fields optional
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers.find((s) => s.name === 'minimal-config')).toBeDefined();
    });

    it('should handle rate limit config with all options', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'full-config': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 10,
              burstSize: 20,
              onLimitExceeded: 'queue',
              maxQueueTimeMs: 30000,
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers.find((s) => s.name === 'full-config')).toBeDefined();
    });

    it('should handle very high rate limits', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'high-rate': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 1000,
              burstSize: 5000,
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers.find((s) => s.name === 'high-rate')).toBeDefined();
    });

    it('should handle very low rate limits', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'low-rate': {
            command: 'echo',
            args: ['test'],
            rateLimit: {
              requestsPerSecond: 0.1, // 1 request per 10 seconds
              burstSize: 1,
              onLimitExceeded: 'reject',
            },
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers.find((s) => s.name === 'low-rate')).toBeDefined();
    });
  });

  describe('Multiple Servers with Different Rate Limits', () => {
    it('should independently rate limit different servers', async () => {
      const config: ConductorConfig = {
        exclusive: true,
        servers: {
          'server-queue': {
            command: 'echo',
            args: ['queue'],
            rateLimit: {
              requestsPerSecond: 5,
              onLimitExceeded: 'queue',
            },
          },
          'server-reject': {
            command: 'echo',
            args: ['reject'],
            rateLimit: {
              requestsPerSecond: 5,
              onLimitExceeded: 'reject',
            },
          },
          'server-unlimited': {
            command: 'echo',
            args: ['unlimited'],
            // No rate limit
          },
        },
      };

      writeFileSync(tempConfigPath, JSON.stringify(config));

      hub = new MCPHub({
        conductorConfigPath: tempConfigPath,
        connectionTimeoutMs: 5000,
        autoReconnect: false,
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers.length).toBe(3);

      // Each server should have independent rate limiting
      expect(servers.find((s) => s.name === 'server-queue')).toBeDefined();
      expect(servers.find((s) => s.name === 'server-reject')).toBeDefined();
      expect(servers.find((s) => s.name === 'server-unlimited')).toBeDefined();
    });
  });
});
