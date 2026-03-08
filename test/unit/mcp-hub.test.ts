import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MCPHub, type HubConfig } from '../../src/hub/mcp-hub.js';

// Mock the MCP SDK client
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        { name: 'test_tool', description: 'A test tool' },
        { name: 'another_tool', description: 'Another tool' },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"result": "success"}' }],
    }),
  })),
}));

// Mock the stdio transport
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    onerror: null,
    onclose: null,
  })),
}));

// Mock the config loader with a configurable mock
const mockClaudeConfig = {
  mcpServers: {
    'test-server': {
      command: 'node',
      args: ['test-server.js'],
    },
    'another-server': {
      command: 'python',
      args: ['-m', 'another_server'],
    },
  },
};

vi.mock('../../src/config/loader.js', () => ({
  loadClaudeConfig: vi.fn().mockImplementation(() => mockClaudeConfig),
  findClaudeConfig: vi.fn().mockReturnValue('/mock/path/config.json'),
  loadConductorConfig: vi.fn().mockReturnValue(null), // No conductor config by default
  findConductorConfig: vi.fn().mockReturnValue(null),
}));

describe('MCPHub', () => {
  let hub: MCPHub;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (hub) {
      await hub.shutdown();
    }
  });

  describe('constructor', () => {
    it('should create hub with default config', () => {
      hub = new MCPHub();
      expect(hub).toBeDefined();
    });

    it('should create hub with custom config', () => {
      const config: HubConfig = {
        connectionTimeoutMs: 60000,
        autoReconnect: false,
        servers: {
          allowList: ['test-server'],
          denyList: [],
        },
      };
      hub = new MCPHub(config);
      expect(hub).toBeDefined();
    });
  });

  describe('initialise', () => {
    it('should initialise and connect to configured servers', async () => {
      hub = new MCPHub();
      await hub.initialise();

      const servers = hub.listServers();
      expect(servers).toHaveLength(2);
      expect(servers.map((s) => s.name)).toContain('test-server');
      expect(servers.map((s) => s.name)).toContain('another-server');
    });

    it('should filter servers based on allowList', async () => {
      hub = new MCPHub({
        servers: {
          allowList: ['test-server'],
          denyList: [],
        },
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('test-server');
    });

    it('should filter servers based on denyList', async () => {
      hub = new MCPHub({
        servers: {
          allowList: [],
          denyList: ['another-server'],
        },
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('test-server');
    });

    it('should allow all servers when allowList contains wildcard "*"', async () => {
      hub = new MCPHub({
        servers: {
          allowList: ['*'],
          denyList: [],
        },
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers).toHaveLength(2);
      expect(servers.map((s) => s.name)).toContain('test-server');
      expect(servers.map((s) => s.name)).toContain('another-server');
    });

    it('should respect denyList even with wildcard allowList', async () => {
      hub = new MCPHub({
        servers: {
          allowList: ['*'],
          denyList: ['another-server'],
        },
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('test-server');
    });

    it('should filter out mcp-conductor self-reference', async () => {
      // Temporarily add mcp-conductor to the mock config
      const originalServers = { ...mockClaudeConfig.mcpServers };
      mockClaudeConfig.mcpServers = {
        ...originalServers,
        'mcp-conductor': {
          command: 'node',
          args: ['dist/index.js'],
        },
      };

      hub = new MCPHub({
        servers: {
          allowList: ['*'],
          denyList: [],
        },
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers.map((s) => s.name)).not.toContain('mcp-conductor');
      expect(servers).toHaveLength(2); // Only test-server and another-server

      // Restore original mock
      mockClaudeConfig.mcpServers = originalServers;
    });

    it('should filter out mcp-executor self-reference', async () => {
      // Temporarily add mcp-executor to the mock config
      const originalServers = { ...mockClaudeConfig.mcpServers };
      mockClaudeConfig.mcpServers = {
        ...originalServers,
        'mcp-executor': {
          command: 'node',
          args: ['dist/index.js'],
        },
      };

      hub = new MCPHub({
        servers: {
          allowList: ['*'],
          denyList: [],
        },
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers.map((s) => s.name)).not.toContain('mcp-executor');
      expect(servers).toHaveLength(2); // Only test-server and another-server

      // Restore original mock
      mockClaudeConfig.mcpServers = originalServers;
    });

    it('should handle empty allowList as allow all', async () => {
      hub = new MCPHub({
        servers: {
          allowList: [],
          denyList: [],
        },
      });

      await hub.initialise();

      const servers = hub.listServers();
      expect(servers).toHaveLength(2);
    });
  });

  describe('listServers', () => {
    it('should return empty array before initialisation', () => {
      hub = new MCPHub();
      const servers = hub.listServers();
      expect(servers).toEqual([]);
    });

    it('should return server info after initialisation', async () => {
      hub = new MCPHub();
      await hub.initialise();

      const servers = hub.listServers();
      expect(servers.length).toBeGreaterThan(0);
      expect(servers[0]).toHaveProperty('name');
      expect(servers[0]).toHaveProperty('status');
      expect(servers[0]).toHaveProperty('toolCount');
    });
  });

  describe('getServerTools', () => {
    it('should return empty array for unknown server', () => {
      hub = new MCPHub();
      const tools = hub.getServerTools('unknown');
      expect(tools).toEqual([]);
    });

    it('should return tools after initialisation', async () => {
      hub = new MCPHub();
      await hub.initialise();

      const tools = hub.getServerTools('test-server');
      expect(tools).toHaveLength(2);
      expect(tools[0]).toHaveProperty('name');
      expect(tools[0]).toHaveProperty('description');
    });
  });

  describe('getAllTools', () => {
    it('should return empty array before initialisation', () => {
      hub = new MCPHub();
      const tools = hub.getAllTools();
      expect(tools).toEqual([]);
    });

    it('should return all tools from all servers', async () => {
      hub = new MCPHub();
      await hub.initialise();

      const tools = hub.getAllTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(tools[0]).toHaveProperty('server');
      expect(tools[0]).toHaveProperty('tool');
    });
  });

  describe('searchTools', () => {
    it('should return empty array before initialisation', () => {
      hub = new MCPHub();
      const results = hub.searchTools('test');
      expect(results).toEqual([]);
    });

    it('should find tools matching query', async () => {
      hub = new MCPHub();
      await hub.initialise();

      const results = hub.searchTools('test');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('server');
      expect(results[0]).toHaveProperty('tool');
      expect(results[0]).toHaveProperty('description');
    });

    it('should return empty array for non-matching query', async () => {
      hub = new MCPHub();
      await hub.initialise();

      const results = hub.searchTools('nonexistent_xyz');
      expect(results).toEqual([]);
    });
  });

  describe('callTool', () => {
    it('should throw for unknown server', async () => {
      hub = new MCPHub();
      await expect(hub.callTool('unknown', 'tool', {})).rejects.toThrow('Server not found');
    });

    it('should call tool on connected server', async () => {
      hub = new MCPHub();
      await hub.initialise();

      const result = await hub.callTool('test-server', 'test_tool', { param: 'value' });
      expect(result).toBeDefined();
    });
  });

  describe('isServerConnected', () => {
    it('should return false for unknown server', () => {
      hub = new MCPHub();
      expect(hub.isServerConnected('unknown')).toBe(false);
    });

    it('should return true for connected server', async () => {
      hub = new MCPHub();
      await hub.initialise();

      expect(hub.isServerConnected('test-server')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return zero stats before initialisation', () => {
      hub = new MCPHub();
      const stats = hub.getStats();

      expect(stats.total).toBe(0);
      expect(stats.connected).toBe(0);
      expect(stats.error).toBe(0);
      expect(stats.disconnected).toBe(0);
    });

    it('should return correct stats after initialisation', async () => {
      hub = new MCPHub();
      await hub.initialise();

      const stats = hub.getStats();
      expect(stats.total).toBe(2);
      expect(stats.connected).toBe(2);
    });
  });

  describe('reload', () => {
    it('should reload server configurations', async () => {
      hub = new MCPHub();
      await hub.initialise();

      const { added, removed } = await hub.reload();
      expect(Array.isArray(added)).toBe(true);
      expect(Array.isArray(removed)).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('should disconnect all servers', async () => {
      hub = new MCPHub();
      await hub.initialise();

      await hub.shutdown();

      const stats = hub.getStats();
      expect(stats.connected).toBe(0);
    });
  });

  describe('events', () => {
    it('should emit serverConnected event', async () => {
      hub = new MCPHub();
      const connectedHandler = vi.fn();
      hub.on('serverConnected', connectedHandler);

      await hub.initialise();

      expect(connectedHandler).toHaveBeenCalled();
    });

    it('should emit toolsCached event', async () => {
      hub = new MCPHub();
      const cachedHandler = vi.fn();
      hub.on('toolsCached', cachedHandler);

      await hub.initialise();

      expect(cachedHandler).toHaveBeenCalled();
    });
  });

  describe('getConfigPath', () => {
    it('should return the config path', () => {
      hub = new MCPHub();
      const path = hub.getConfigPath();
      expect(path).toBe('/mock/path/config.json');
    });
  });
});
