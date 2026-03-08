import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpBridge, type BridgeHandlers, type ServerInfo } from '../../src/bridge/http-server.js';
import type { BridgeConfig } from '../../src/config/schema.js';

describe('HttpBridge', () => {
  let bridge: HttpBridge;
  let bridgeConfig: BridgeConfig;
  let handlers: BridgeHandlers;
  const TEST_PORT = 19847; // Use different port to avoid conflicts

  beforeEach(() => {
    bridgeConfig = {
      port: TEST_PORT,
      host: 'localhost',
    };

    handlers = {
      listServers: (): ServerInfo[] => [
        { name: 'echo', toolCount: 2, status: 'connected' },
        { name: 'filesystem', toolCount: 5, status: 'connected' },
      ],
      listTools: (serverName: string) => {
        if (serverName === 'echo') {
          return [
            { name: 'reverse', description: 'Reverse a string' },
            { name: 'echo', description: 'Echo input' },
          ];
        }
        return [];
      },
      callTool: async (
        serverName: string,
        toolName: string,
        params: Record<string, unknown>
      ) => ({ server: serverName, tool: toolName, params }),
      searchTools: (query: string) => [
        { server: 'echo', tool: 'reverse', description: `Search result for: ${query}` },
      ],
    };

    bridge = new HttpBridge(bridgeConfig);
  });

  afterEach(async () => {
    await bridge.stop();
  });

  describe('constructor', () => {
    it('should create bridge with config', () => {
      expect(bridge).toBeDefined();
    });
  });

  describe('start/stop', () => {
    it('should start and stop the server', async () => {
      bridge.setHandlers(handlers);
      await bridge.start();
      // Server is running - verify by making a request
      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      expect(response.ok).toBe(true);

      await bridge.stop();
      // After stop, requests should fail
      await expect(fetch(`http://localhost:${TEST_PORT}/health`)).rejects.toThrow();
    });

    it('should handle stopping when not running', async () => {
      await expect(bridge.stop()).resolves.not.toThrow();
    });

    it('should throw when starting twice', async () => {
      bridge.setHandlers(handlers);
      await bridge.start();
      await expect(bridge.start()).rejects.toThrow('already running');
    });
  });

  describe('getUrl', () => {
    it('should return correct URL', () => {
      const url = bridge.getUrl();
      expect(url).toBe(`http://localhost:${TEST_PORT}`);
    });
  });

  describe('HTTP endpoints', () => {
    beforeEach(async () => {
      bridge.setHandlers(handlers);
      await bridge.start();
    });

    describe('GET /health', () => {
      it('should respond to health check', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/health`);
        expect(response.ok).toBe(true);

        const data = await response.json();
        expect(data.status).toBe('ok');
        expect(data.uptime).toBeGreaterThanOrEqual(0);
        expect(data.serversConnected).toBe(2);
      });
    });

    describe('GET /servers', () => {
      it('should list servers', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/servers`);
        expect(response.ok).toBe(true);

        const data = await response.json();
        expect(data.servers).toHaveLength(2);
        expect(data.servers[0].name).toBe('echo');
        expect(data.servers[0].status).toBe('connected');
      });
    });

    describe('GET /servers/:name/tools', () => {
      it('should list server tools', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/servers/echo/tools`);
        expect(response.ok).toBe(true);

        const data = await response.json();
        expect(data.tools).toHaveLength(2);
        expect(data.tools[0].name).toBe('reverse');
      });

      it('should handle unknown server', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/servers/unknown/tools`);
        expect(response.ok).toBe(true);

        const data = await response.json();
        expect(data.tools).toEqual([]);
      });
    });

    describe('POST /call', () => {
      it('should call tools', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            server: 'echo',
            tool: 'reverse',
            params: { message: 'hello' },
          }),
        });
        expect(response.ok).toBe(true);

        const data = await response.json();
        expect(data.result.server).toBe('echo');
        expect(data.result.tool).toBe('reverse');
        expect(data.result.params.message).toBe('hello');
        expect(data.metrics).toBeDefined();
        expect(data.metrics.durationMs).toBeGreaterThanOrEqual(0);
      });

      it('should handle missing server/tool in call', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: 'reverse' }), // Missing server
        });
        expect(response.status).toBe(400);

        const data = await response.json();
        expect(data.error).toContain('Missing');
      });

      it('should handle tool call errors', async () => {
        const errorHandlers: BridgeHandlers = {
          ...handlers,
          callTool: async () => {
            throw new Error('Tool execution failed');
          },
        };
        await bridge.stop();
        bridge = new HttpBridge(bridgeConfig);
        bridge.setHandlers(errorHandlers);
        await bridge.start();

        const response = await fetch(`http://localhost:${TEST_PORT}/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            server: 'echo',
            tool: 'reverse',
            params: {},
          }),
        });

        const data = await response.json();
        expect(data.error).toBeDefined();
        expect(data.error.message).toContain('Tool execution failed');
      });
    });

    describe('GET /search', () => {
      it('should search tools', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/search?q=reverse`);
        expect(response.ok).toBe(true);

        const data = await response.json();
        expect(data.results).toHaveLength(1);
        expect(data.results[0].tool).toBe('reverse');
      });

      it('should handle empty search query', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/search`);
        expect(response.ok).toBe(true);

        const data = await response.json();
        expect(data.results).toBeDefined();
      });
    });

    describe('error handling', () => {
      it('should return 404 for unknown routes', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/unknown`);
        expect(response.status).toBe(404);
      });

      it('should handle CORS preflight', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/health`, {
          method: 'OPTIONS',
        });
        expect(response.status).toBe(204);
      });
    });
  });

  describe('without handlers', () => {
    it('should return 503 when handlers not set', async () => {
      await bridge.start(); // Start without setting handlers

      const response = await fetch(`http://localhost:${TEST_PORT}/servers`);
      expect(response.status).toBe(503);
    });
  });
});
