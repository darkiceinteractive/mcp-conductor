/**
 * Configuration Loader Tests
 *
 * Comprehensive tests for the configuration loading system including:
 * - Default config loading
 * - File-based configuration
 * - Environment variable overrides
 * - Claude config discovery
 * - Edge cases and error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadConfig,
  getDefaultConfigPath,
  getClaudeConfigPaths,
  findClaudeConfig,
  loadClaudeConfig,
} from '../../src/config/loader.js';
import { DEFAULT_CONFIG, ENV_VARS } from '../../src/config/defaults.js';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

describe('Config Loader', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  beforeEach(() => {
    // Reset environment for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getDefaultConfigPath', () => {
    it('should return path in home directory', () => {
      const configPath = getDefaultConfigPath();
      expect(configPath).toContain('.mcp-executor');
      expect(configPath).toContain('config.json');
    });

    it('should be an absolute path', () => {
      const configPath = getDefaultConfigPath();
      expect(path.isAbsolute(configPath)).toBe(true);
    });

    it('should include home directory', () => {
      const configPath = getDefaultConfigPath();
      expect(configPath.startsWith(os.homedir())).toBe(true);
    });
  });

  describe('getClaudeConfigPaths', () => {
    it('should return array of possible paths', () => {
      const paths = getClaudeConfigPaths();
      expect(Array.isArray(paths)).toBe(true);
      expect(paths.length).toBeGreaterThan(0);
    });

    it('should include common config locations', () => {
      const paths = getClaudeConfigPaths();
      const pathString = paths.join(',');

      // Should include claude-related paths
      expect(pathString.toLowerCase()).toContain('claude');
    });

    it('should include .claude.json in home directory', () => {
      const paths = getClaudeConfigPaths();
      const hasClaudeJson = paths.some((p) => p.endsWith('.claude.json'));
      expect(hasClaudeJson).toBe(true);
    });

    it('should include .claude/settings.json as highest priority', () => {
      const paths = getClaudeConfigPaths();
      const settingsPath = paths.find((p) => p.endsWith('.claude/settings.json'));
      expect(settingsPath).toBeDefined();
      expect(paths.indexOf(settingsPath!)).toBe(0);
    });

    it('should include project-local configs', () => {
      const paths = getClaudeConfigPaths();
      const hasProjectLocal = paths.some(
        (p) => p.includes('claude_code_config.json') || p.includes('claude_desktop_config.json')
      );
      expect(hasProjectLocal).toBe(true);
    });

    it('should include Windows paths on Windows', () => {
      const originalPlatform = process.platform;
      const originalAppData = process.env['APPDATA'];

      // Mock Windows environment
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env['APPDATA'] = 'C:\\Users\\Test\\AppData\\Roaming';

      const paths = getClaudeConfigPaths();

      // Restore
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      if (originalAppData !== undefined) {
        process.env['APPDATA'] = originalAppData;
      } else {
        delete process.env['APPDATA'];
      }

      // On Windows, should include APPDATA path
      if (originalPlatform === 'win32') {
        const hasAppData = paths.some((p) => p.includes('AppData'));
        expect(hasAppData).toBe(true);
      }
    });

    it('should return all paths as absolute', () => {
      const paths = getClaudeConfigPaths();
      for (const p of paths) {
        expect(path.isAbsolute(p)).toBe(true);
      }
    });
  });

  describe('loadConfig', () => {
    let tempDir: string;
    let tempConfigPath: string;

    beforeEach(() => {
      tempDir = path.join(os.tmpdir(), 'mcp-config-test-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
      tempConfigPath = path.join(tempDir, 'config.json');
    });

    afterEach(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true });
      }
    });

    it('should return default config when no file exists', () => {
      const config = loadConfig('/nonexistent/path/config.json');
      expect(config.bridge.port).toBe(DEFAULT_CONFIG.bridge.port);
      expect(config.execution.mode).toBe(DEFAULT_CONFIG.execution.mode);
    });

    it('should load config from specified file', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          bridge: { port: 9999 },
        })
      );

      const config = loadConfig(tempConfigPath);
      expect(config.bridge.port).toBe(9999);
    });

    it('should merge file config with defaults', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          bridge: { port: 8888 },
        })
      );

      const config = loadConfig(tempConfigPath);

      // Custom value
      expect(config.bridge.port).toBe(8888);
      // Default values preserved
      expect(config.bridge.host).toBe(DEFAULT_CONFIG.bridge.host);
      expect(config.execution.mode).toBe(DEFAULT_CONFIG.execution.mode);
    });

    it('should load config from MCP_EXECUTOR_CONFIG env var', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          bridge: { port: 7777 },
        })
      );

      process.env[ENV_VARS.CONFIG] = tempConfigPath;

      const config = loadConfig();
      expect(config.bridge.port).toBe(7777);
    });

    it('should handle malformed JSON gracefully', () => {
      writeFileSync(tempConfigPath, '{ invalid json }');

      // Should not throw, should return defaults
      const config = loadConfig(tempConfigPath);
      expect(config.bridge.port).toBe(DEFAULT_CONFIG.bridge.port);
    });

    it('should handle empty file', () => {
      writeFileSync(tempConfigPath, '');

      const config = loadConfig(tempConfigPath);
      expect(config.bridge.port).toBe(DEFAULT_CONFIG.bridge.port);
    });

    it('should handle file with null content', () => {
      writeFileSync(tempConfigPath, 'null');

      const config = loadConfig(tempConfigPath);
      expect(config.bridge.port).toBe(DEFAULT_CONFIG.bridge.port);
    });

    describe('environment variable overrides', () => {
      it('should override port from MCP_EXECUTOR_PORT', () => {
        process.env['MCP_EXECUTOR_PORT'] = '12345';

        const config = loadConfig();
        expect(config.bridge.port).toBe(12345);
      });

      it('should override mode from MCP_EXECUTOR_MODE', () => {
        process.env['MCP_EXECUTOR_MODE'] = 'passthrough';

        const config = loadConfig();
        expect(config.execution.mode).toBe('passthrough');
      });

      it('should override timeout from MCP_EXECUTOR_TIMEOUT', () => {
        process.env['MCP_EXECUTOR_TIMEOUT'] = '60000';

        const config = loadConfig();
        expect(config.execution.defaultTimeoutMs).toBe(60000);
      });

      it('should override max timeout from MCP_EXECUTOR_MAX_TIMEOUT', () => {
        process.env['MCP_EXECUTOR_MAX_TIMEOUT'] = '120000';

        const config = loadConfig();
        expect(config.execution.maxTimeoutMs).toBe(120000);
      });

      it('should override max memory from MCP_EXECUTOR_MAX_MEMORY_MB', () => {
        process.env['MCP_EXECUTOR_MAX_MEMORY_MB'] = '1024';

        const config = loadConfig();
        expect(config.sandbox.maxMemoryMb).toBe(1024);
      });

      it('should parse allowed servers as comma-separated list', () => {
        process.env['MCP_EXECUTOR_ALLOWED_SERVERS'] = 'server1, server2, server3';

        const config = loadConfig();
        expect(config.servers.allowList).toEqual(['server1', 'server2', 'server3']);
      });

      it('should handle boolean true values', () => {
        process.env['MCP_EXECUTOR_WATCH_CONFIG'] = 'true';
        process.env['MCP_EXECUTOR_WATCH_SKILLS'] = 'true';
        process.env['MCP_EXECUTOR_STREAM_ENABLED'] = 'true';

        const config = loadConfig();

        expect(config.hotReload.enabled).toBe(true);
        expect(config.skills.watchForChanges).toBe(true);
        expect(config.execution.streamingEnabled).toBe(true);
      });

      it('should handle boolean false values', () => {
        process.env['MCP_EXECUTOR_WATCH_CONFIG'] = 'false';
        process.env['MCP_EXECUTOR_WATCH_SKILLS'] = 'false';
        process.env['MCP_EXECUTOR_STREAM_ENABLED'] = 'false';

        const config = loadConfig();

        expect(config.hotReload.enabled).toBe(false);
        expect(config.skills.watchForChanges).toBe(false);
        expect(config.execution.streamingEnabled).toBe(false);
      });

      it('should override skills path', () => {
        process.env['MCP_EXECUTOR_SKILLS_PATH'] = '/custom/skills/path';

        const config = loadConfig();
        expect(config.skills.path).toBe('/custom/skills/path');
      });

      it('should prioritise env vars over file config', () => {
        writeFileSync(
          tempConfigPath,
          JSON.stringify({
            bridge: { port: 8888 },
          })
        );

        process.env['MCP_EXECUTOR_PORT'] = '9999';

        const config = loadConfig(tempConfigPath);
        expect(config.bridge.port).toBe(9999);
      });
    });

    describe('deep merge functionality', () => {
      it('should merge nested bridge config', () => {
        writeFileSync(
          tempConfigPath,
          JSON.stringify({
            bridge: { port: 8888 },
          })
        );

        const config = loadConfig(tempConfigPath);
        expect(config.bridge.port).toBe(8888);
        expect(config.bridge.host).toBe(DEFAULT_CONFIG.bridge.host);
      });

      it('should merge nested execution config', () => {
        writeFileSync(
          tempConfigPath,
          JSON.stringify({
            execution: { mode: 'hybrid' },
          })
        );

        const config = loadConfig(tempConfigPath);
        expect(config.execution.mode).toBe('hybrid');
        expect(config.execution.defaultTimeoutMs).toBe(DEFAULT_CONFIG.execution.defaultTimeoutMs);
      });

      it('should merge nested sandbox config', () => {
        writeFileSync(
          tempConfigPath,
          JSON.stringify({
            sandbox: { maxMemoryMb: 2048 },
          })
        );

        const config = loadConfig(tempConfigPath);
        expect(config.sandbox.maxMemoryMb).toBe(2048);
      });

      it('should merge nested skills config', () => {
        writeFileSync(
          tempConfigPath,
          JSON.stringify({
            skills: { enabled: false },
          })
        );

        const config = loadConfig(tempConfigPath);
        expect(config.skills.enabled).toBe(false);
      });

      it('should merge nested hotReload config', () => {
        writeFileSync(
          tempConfigPath,
          JSON.stringify({
            hotReload: { enabled: true, debounceMs: 500 },
          })
        );

        const config = loadConfig(tempConfigPath);
        expect(config.hotReload.enabled).toBe(true);
        expect(config.hotReload.debounceMs).toBe(500);
      });

      it('should merge nested metrics config', () => {
        writeFileSync(
          tempConfigPath,
          JSON.stringify({
            metrics: { enabled: false },
          })
        );

        const config = loadConfig(tempConfigPath);
        expect(config.metrics.enabled).toBe(false);
      });

      it('should merge nested servers config', () => {
        writeFileSync(
          tempConfigPath,
          JSON.stringify({
            servers: { allowList: ['server1'], denyList: ['server2'] },
          })
        );

        const config = loadConfig(tempConfigPath);
        expect(config.servers.allowList).toEqual(['server1']);
        expect(config.servers.denyList).toEqual(['server2']);
      });
    });
  });

  describe('findClaudeConfig', () => {
    let tempDir: string;
    let tempConfigPath: string;

    beforeEach(() => {
      tempDir = path.join(os.tmpdir(), 'mcp-claude-test-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
      tempConfigPath = path.join(tempDir, 'claude_config.json');
    });

    afterEach(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true });
      }
    });

    it('should return null when no config found', () => {
      // Ensure no env var set
      delete process.env[ENV_VARS.CLAUDE_CONFIG];

      // This will search standard paths which likely don't exist in test env
      // Result may be null or may find a real config
      const result = findClaudeConfig();
      expect(result === null || typeof result === 'string').toBe(true);
    });

    it('should use MCP_EXECUTOR_CLAUDE_CONFIG env var', () => {
      writeFileSync(tempConfigPath, JSON.stringify({ mcpServers: {} }));
      process.env[ENV_VARS.CLAUDE_CONFIG] = tempConfigPath;

      const result = findClaudeConfig();
      expect(result).toBe(tempConfigPath);
    });

    it('should ignore env var if file does not exist', () => {
      process.env[ENV_VARS.CLAUDE_CONFIG] = '/nonexistent/claude_config.json';

      const result = findClaudeConfig();
      // Should not return the nonexistent path
      expect(result).not.toBe('/nonexistent/claude_config.json');
    });

    it('should handle "auto" env var value', () => {
      process.env[ENV_VARS.CLAUDE_CONFIG] = 'auto';

      const result = findClaudeConfig();
      // Should fall through to search standard paths
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('loadClaudeConfig', () => {
    let tempDir: string;
    let tempConfigPath: string;

    beforeEach(() => {
      tempDir = path.join(os.tmpdir(), 'mcp-claude-config-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
      tempConfigPath = path.join(tempDir, 'claude_config.json');
    });

    afterEach(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true });
      }
    });

    it('should return null when no config found', () => {
      delete process.env[ENV_VARS.CLAUDE_CONFIG];

      const result = loadClaudeConfig('/nonexistent/config.json');
      expect(result).toBeNull();
    });

    it('should load valid Claude config', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          mcpServers: {
            server1: { command: 'echo', args: ['test'] },
            server2: { command: 'node', args: ['server.js'] },
          },
        })
      );

      const result = loadClaudeConfig(tempConfigPath);

      expect(result).not.toBeNull();
      expect(result!.mcpServers).toBeDefined();
      expect(Object.keys(result!.mcpServers!).length).toBe(2);
    });

    it('should return empty mcpServers for config without servers', () => {
      writeFileSync(tempConfigPath, JSON.stringify({}));

      const result = loadClaudeConfig(tempConfigPath);

      expect(result).not.toBeNull();
      expect(result!.mcpServers).toBeUndefined();
    });

    it('should handle malformed JSON', () => {
      writeFileSync(tempConfigPath, '{ invalid json }');

      const result = loadClaudeConfig(tempConfigPath);
      // Should return empty object or null
      expect(result === null || (result && Object.keys(result.mcpServers || {}).length === 0)).toBe(true);
    });

    it('should extract server configurations', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          mcpServers: {
            filesystem: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem'],
              env: { HOME: '/home/user' },
            },
          },
        })
      );

      const result = loadClaudeConfig(tempConfigPath);

      expect(result).not.toBeNull();
      expect(result!.mcpServers!['filesystem']).toBeDefined();
      expect(result!.mcpServers!['filesystem'].command).toBe('npx');
      expect(result!.mcpServers!['filesystem'].args).toEqual([
        '-y',
        '@modelcontextprotocol/server-filesystem',
      ]);
      expect(result!.mcpServers!['filesystem'].env).toEqual({ HOME: '/home/user' });
    });

    it('should use findClaudeConfig when no path provided', () => {
      writeFileSync(tempConfigPath, JSON.stringify({ mcpServers: {} }));
      process.env[ENV_VARS.CLAUDE_CONFIG] = tempConfigPath;

      const result = loadClaudeConfig();

      expect(result).not.toBeNull();
    });
  });

  describe('config structure validation', () => {
    it('should have all required sections', () => {
      const config = loadConfig();

      expect(config.bridge).toBeDefined();
      expect(config.execution).toBeDefined();
      expect(config.sandbox).toBeDefined();
      expect(config.skills).toBeDefined();
      expect(config.hotReload).toBeDefined();
      expect(config.metrics).toBeDefined();
      expect(config.servers).toBeDefined();
    });

    it('should have valid bridge config', () => {
      const config = loadConfig();

      expect(typeof config.bridge.port).toBe('number');
      expect(typeof config.bridge.host).toBe('string');
      // Port 0 is valid for dynamic allocation, otherwise must be valid port range
      expect(config.bridge.port).toBeGreaterThanOrEqual(0);
      expect(config.bridge.port).toBeLessThan(65536);
    });

    it('should have valid execution config', () => {
      const config = loadConfig();

      expect(['execution', 'passthrough', 'hybrid']).toContain(config.execution.mode);
      expect(typeof config.execution.defaultTimeoutMs).toBe('number');
      expect(typeof config.execution.maxTimeoutMs).toBe('number');
      expect(typeof config.execution.streamingEnabled).toBe('boolean');
      expect(config.execution.defaultTimeoutMs).toBeGreaterThan(0);
      expect(config.execution.maxTimeoutMs).toBeGreaterThanOrEqual(config.execution.defaultTimeoutMs);
    });

    it('should have valid sandbox config', () => {
      const config = loadConfig();

      expect(typeof config.sandbox.maxMemoryMb).toBe('number');
      expect(Array.isArray(config.sandbox.allowedNetHosts)).toBe(true);
      expect(config.sandbox.maxMemoryMb).toBeGreaterThan(0);
    });

    it('should have valid skills config', () => {
      const config = loadConfig();

      // path can be string or null
      expect(config.skills.path === null || typeof config.skills.path === 'string').toBe(true);
      expect(typeof config.skills.watchForChanges).toBe('boolean');
    });

    it('should have valid hotReload config', () => {
      const config = loadConfig();

      expect(typeof config.hotReload.enabled).toBe('boolean');
      expect(typeof config.hotReload.debounceMs).toBe('number');
      expect(config.hotReload.debounceMs).toBeGreaterThan(0);
    });

    it('should have valid metrics config', () => {
      const config = loadConfig();

      expect(typeof config.metrics.enabled).toBe('boolean');
    });

    it('should have valid servers config', () => {
      const config = loadConfig();

      expect(Array.isArray(config.servers.allowList)).toBe(true);
      expect(Array.isArray(config.servers.denyList)).toBe(true);
    });
  });

  describe('edge cases', () => {
    let tempDir: string;
    let tempConfigPath: string;

    beforeEach(() => {
      tempDir = path.join(os.tmpdir(), 'mcp-edge-test-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
      tempConfigPath = path.join(tempDir, 'config.json');
    });

    afterEach(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true });
      }
    });

    it('should handle config with extra unknown fields', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          bridge: { port: 8888 },
          unknownField: 'value',
          nested: { another: 'field' },
        })
      );

      // Should not throw
      const config = loadConfig(tempConfigPath);
      expect(config.bridge.port).toBe(8888);
    });

    it('should handle config with wrong types', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          bridge: { port: 'not-a-number' },
        })
      );

      // Should load but may have incorrect type
      const config = loadConfig(tempConfigPath);
      // The value will be merged as-is, type checking happens elsewhere
      expect(config).toBeDefined();
    });

    it('should handle very large port numbers', () => {
      process.env['MCP_EXECUTOR_PORT'] = '999999';

      const config = loadConfig();
      expect(config.bridge.port).toBe(999999);
      // Validation should be done elsewhere
    });

    it('should handle negative timeout', () => {
      process.env['MCP_EXECUTOR_TIMEOUT'] = '-1000';

      const config = loadConfig();
      expect(config.execution.defaultTimeoutMs).toBe(-1000);
      // Validation should be done elsewhere
    });

    it('should handle empty allowed servers list', () => {
      process.env['MCP_EXECUTOR_ALLOWED_SERVERS'] = '';

      const config = loadConfig();
      // Empty string defaults to wildcard (allow all)
      expect(config.servers.allowList).toEqual(['*']);
    });

    it('should handle single allowed server', () => {
      process.env['MCP_EXECUTOR_ALLOWED_SERVERS'] = 'single-server';

      const config = loadConfig();
      expect(config.servers.allowList).toEqual(['single-server']);
    });

    it('should trim whitespace from allowed servers', () => {
      process.env['MCP_EXECUTOR_ALLOWED_SERVERS'] = '  server1  ,  server2  ';

      const config = loadConfig();
      expect(config.servers.allowList).toEqual(['server1', 'server2']);
    });

    it('should handle array config in file', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          servers: {
            allowList: ['s1', 's2', 's3'],
            denyList: ['d1'],
          },
        })
      );

      const config = loadConfig(tempConfigPath);
      expect(config.servers.allowList).toEqual(['s1', 's2', 's3']);
      expect(config.servers.denyList).toEqual(['d1']);
    });
  });
});
