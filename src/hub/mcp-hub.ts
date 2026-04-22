/**
 * MCP Hub - Connects to and manages real MCP servers
 *
 * This component:
 * - Reads Claude config files to discover MCP servers
 * - Spawns and connects to each server via stdio transport
 * - Maintains connection pool with health monitoring
 * - Caches tool schemas for efficient discovery
 * - Supports hot-reload of server configurations
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { EventEmitter } from 'node:events';
import { logger, RateLimiter, minimalChildEnv } from '../utils/index.js';
import {
  loadClaudeConfig,
  findClaudeConfig,
  loadConductorConfig,
  findConductorConfig,
} from '../config/loader.js';
import type { ClaudeConfig, ServersConfig, ConductorConfig, RateLimitConfig } from '../config/schema.js';

export type ServerStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ServerConnection {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  status: ServerStatus;
  tools: Tool[];
  connectedAt?: Date;
  lastError?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  rateLimiter?: RateLimiter;
  rateLimitConfig?: RateLimitConfig;
}

export interface HubConfig {
  /** Path to Claude config file (auto-detect if not specified) */
  claudeConfigPath?: string;
  /** Path to conductor config file (auto-detect if not specified) */
  conductorConfigPath?: string;
  /** Server allow/deny lists */
  servers?: ServersConfig;
  /** Connection timeout in milliseconds */
  connectionTimeoutMs?: number;
  /** Whether to auto-reconnect failed connections */
  autoReconnect?: boolean;
  /** Reconnect delay in milliseconds */
  reconnectDelayMs?: number;
  /** Maximum reconnect attempts */
  maxReconnectAttempts?: number;
}

export interface HubEvents {
  serverConnected: (serverName: string) => void;
  serverDisconnected: (serverName: string, error?: Error) => void;
  serverError: (serverName: string, error: Error) => void;
  serversChanged: (added: string[], removed: string[]) => void;
  toolsCached: (serverName: string, toolCount: number) => void;
}

const DEFAULT_HUB_CONFIG: Required<HubConfig> = {
  claudeConfigPath: '',
  conductorConfigPath: '',
  servers: { allowList: [], denyList: [] },
  connectionTimeoutMs: 30000,
  autoReconnect: true,
  reconnectDelayMs: 5000,
  maxReconnectAttempts: 3,
};

export class MCPHub extends EventEmitter {
  private config: Required<HubConfig>;
  private connections: Map<string, ServerConnection> = new Map();
  private toolCache: Map<string, Tool[]> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private isShuttingDown = false;

  constructor(config: HubConfig = {}) {
    super();
    this.config = { ...DEFAULT_HUB_CONFIG, ...config };
  }

  /**
   * Initialise the hub and connect to all configured servers
   */
  async initialise(): Promise<void> {
    logger.info('Initialising MCP Hub');

    // Build a merged server map based on conductor config and/or Claude config
    const serverMap = await this.discoverServers();

    if (Object.keys(serverMap).length === 0) {
      logger.warn('No MCP servers found in any configuration');
      return;
    }

    const serverNames = Object.keys(serverMap);
    const filteredServers = this.filterServers(serverNames);

    logger.info(`Found ${serverNames.length} servers, connecting to ${filteredServers.length}`, {
      total: serverNames.length,
      filtered: filteredServers.length,
      servers: filteredServers,
    });

    // Connect to all servers concurrently
    const connectionPromises = filteredServers.map((name) => {
      const serverConfig = serverMap[name];
      if (!serverConfig) return Promise.resolve(false);
      return this.connectServer(name, serverConfig);
    });

    await Promise.allSettled(connectionPromises);

    const connected = Array.from(this.connections.values()).filter(
      (c) => c.status === 'connected'
    ).length;

    logger.info(`MCP Hub initialised`, {
      connected,
      total: filteredServers.length,
    });
  }

  /**
   * Discover servers from conductor config and/or Claude config
   * Returns a merged map of server configurations
   */
  private async discoverServers(): Promise<
    Record<string, { command: string; args?: string[]; env?: Record<string, string>; rateLimit?: RateLimitConfig }>
  > {
    const serverMap: Record<
      string,
      { command: string; args?: string[]; env?: Record<string, string>; rateLimit?: RateLimitConfig }
    > = {};

    // 1. Check for conductor config first (exclusive mode)
    const conductorConfig = loadConductorConfig(this.config.conductorConfigPath || undefined);

    if (conductorConfig && Object.keys(conductorConfig.servers || {}).length > 0) {
      // Add servers from conductor config
      for (const [name, config] of Object.entries(conductorConfig.servers)) {
        serverMap[name] = config;
      }

      logger.info('Using conductor config', {
        exclusive: conductorConfig.exclusive,
        serverCount: Object.keys(conductorConfig.servers).length,
      });

      // If exclusive mode, return only conductor servers
      if (conductorConfig.exclusive) {
        logger.debug('Exclusive mode enabled - using only conductor config servers');
        return serverMap;
      }

      // If not exclusive, continue to add Claude config servers
      logger.debug('Non-exclusive mode - will merge with Claude config');
    }

    // 2. Load Claude config (if no conductor config or non-exclusive mode)
    const claudeConfig = loadClaudeConfig(this.config.claudeConfigPath || undefined);

    if (claudeConfig?.mcpServers) {
      for (const [name, config] of Object.entries(claudeConfig.mcpServers)) {
        // Don't override servers already defined in conductor config
        if (!serverMap[name]) {
          serverMap[name] = config;
        }
      }

      logger.debug('Added servers from Claude config', {
        claudeServerCount: Object.keys(claudeConfig.mcpServers).length,
        totalServerCount: Object.keys(serverMap).length,
      });
    }

    return serverMap;
  }

  /**
   * Filter servers based on allow/deny lists
   */
  private filterServers(serverNames: string[]): string[] {
    const { allowList, denyList } = this.config.servers;

    return serverNames.filter((name) => {
      // Skip self-reference to avoid circular connection
      if (name === 'mcp-conductor' || name === 'mcp-executor') {
        return false;
      }

      // Check allow list - '*' means allow all, otherwise server must be in list
      const allowsAll = allowList.includes('*');
      if (!allowsAll && allowList.length > 0 && !allowList.includes(name)) {
        return false;
      }

      // If server is in deny list, exclude it
      if (denyList.includes(name)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Connect to a single MCP server
   */
  async connectServer(
    name: string,
    serverConfig: { command: string; args?: string[]; env?: Record<string, string>; rateLimit?: RateLimitConfig }
  ): Promise<boolean> {
    if (this.isShuttingDown) {
      return false;
    }

    // Clean up existing connection before creating new one
    const existing = this.connections.get(name);
    if (existing && existing.status !== 'disconnected') {
      try {
        if (existing.transport) {
          existing.transport.onerror = undefined;
          existing.transport.onclose = undefined;
        }
        if (existing.rateLimiter) existing.rateLimiter.destroy();
        await existing.client.close();
      } catch {
        // Ignore cleanup errors during reconnect
      }
    }

    try {
      logger.debug(`Connecting to server: ${name}`, {
        command: serverConfig.command,
        args: serverConfig.args,
      });

      const client = new Client({
        name: `mcp-executor-${name}`,
        version: '1.0.0',
      });

      // Build env with defined values only
      // Only pass PATH + HOME + server-specific env (not full process.env)
      const transportEnv =
        serverConfig.env && Object.keys(serverConfig.env).length > 0
          ? minimalChildEnv(serverConfig.env)
          : undefined;

      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args || [],
        env: transportEnv,
      });

      // Create rate limiter if configured
      let rateLimiter: RateLimiter | undefined;
      if (serverConfig.rateLimit) {
        rateLimiter = new RateLimiter(serverConfig.rateLimit, name);
        logger.info(`Rate limiter configured for ${name}`, {
          requestsPerSecond: serverConfig.rateLimit.requestsPerSecond,
          burstSize: serverConfig.rateLimit.burstSize,
          mode: serverConfig.rateLimit.onLimitExceeded || 'queue',
        });
      }

      const connection: ServerConnection = {
        name,
        client,
        transport,
        status: 'connecting',
        tools: [],
        command: serverConfig.command,
        args: serverConfig.args || [],
        env: serverConfig.env,
        rateLimiter,
        rateLimitConfig: serverConfig.rateLimit,
      };

      this.connections.set(name, connection);

      // Set up error handling
      transport.onerror = (error) => {
        logger.error(`Transport error for ${name}`, { error: String(error) });
        connection.status = 'error';
        connection.lastError = String(error);
        this.emit('serverError', name, error instanceof Error ? error : new Error(String(error)));
        this.handleDisconnection(name);
      };

      transport.onclose = () => {
        if (connection.status === 'connected') {
          logger.warn(`Server ${name} disconnected`);
          connection.status = 'disconnected';
          this.emit('serverDisconnected', name);
          this.handleDisconnection(name);
        }
      };

      // Connect with timeout
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), this.config.connectionTimeoutMs)
        ),
      ]);

      connection.status = 'connected';
      connection.connectedAt = new Date();
      this.reconnectAttempts.delete(name);

      // Cache tools
      await this.cacheServerTools(name, client);

      logger.info(`Connected to server: ${name}`, {
        toolCount: connection.tools.length,
      });

      this.emit('serverConnected', name);
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to connect to server: ${name}`, { error: errorMessage });

      const connection = this.connections.get(name);
      if (connection) {
        connection.status = 'error';
        connection.lastError = errorMessage;
      }

      this.emit('serverError', name, error instanceof Error ? error : new Error(errorMessage));
      this.handleDisconnection(name);
      return false;
    }
  }

  /**
   * Handle server disconnection with optional reconnection
   */
  private async handleDisconnection(name: string): Promise<void> {
    if (this.isShuttingDown || !this.config.autoReconnect) {
      return;
    }

    const connection = this.connections.get(name);
    if (!connection) {
      return;
    }

    const attempts = (this.reconnectAttempts.get(name) || 0) + 1;
    this.reconnectAttempts.set(name, attempts);

    if (attempts > this.config.maxReconnectAttempts) {
      logger.warn(`Max reconnect attempts reached for ${name}`, { attempts });
      return;
    }

    logger.info(`Scheduling reconnect for ${name}`, {
      attempt: attempts,
      maxAttempts: this.config.maxReconnectAttempts,
      delayMs: this.config.reconnectDelayMs,
    });

    // Clear any existing timer for this server
    const existingTimer = this.reconnectTimers.get(name);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(name);
      if (this.isShuttingDown) return;

      logger.info(`Attempting reconnect for ${name}`, { attempt: attempts });
      await this.connectServer(name, {
        command: connection.command,
        args: connection.args,
        env: connection.env,
      });
    }, this.config.reconnectDelayMs);

    this.reconnectTimers.set(name, timer);
  }

  /**
   * Cache tools from a connected server
   */
  private async cacheServerTools(name: string, client: Client): Promise<void> {
    try {
      const response = await client.listTools();
      const tools = response.tools || [];

      const connection = this.connections.get(name);
      if (connection) {
        connection.tools = tools;
      }

      this.toolCache.set(name, tools);
      this.emit('toolsCached', name, tools.length);

      logger.debug(`Cached ${tools.length} tools for ${name}`, {
        tools: tools.map((t) => t.name),
      });
    } catch (error) {
      logger.warn(`Failed to cache tools for ${name}`, { error: String(error) });
    }
  }

  /**
   * Disconnect from a specific server
   */
  async disconnectServer(name: string): Promise<void> {
    // Clear any pending reconnect timer
    const timer = this.reconnectTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(name);
    }

    const connection = this.connections.get(name);
    if (!connection) {
      return;
    }

    // Clean up transport event handlers
    if (connection.transport) {
      connection.transport.onerror = undefined;
      connection.transport.onclose = undefined;
    }

    // Clean up rate limiter
    if (connection.rateLimiter) {
      connection.rateLimiter.destroy();
    }

    try {
      await connection.client.close();
    } catch (error) {
      logger.debug(`Error closing connection to ${name}`, { error: String(error) });
    }

    connection.status = 'disconnected';
    this.toolCache.delete(name);
    this.connections.delete(name);

    logger.info(`Disconnected from server: ${name}`);
  }

  /**
   * Reload server configurations
   */
  async reload(): Promise<{ added: string[]; removed: string[] }> {
    logger.info('Reloading MCP Hub configuration');

    const serverMap = await this.discoverServers();
    const currentServerNames = Array.from(this.connections.keys());

    if (Object.keys(serverMap).length === 0 && currentServerNames.length === 0) {
      logger.warn('No MCP servers found during reload');
      return { added: [], removed: [] };
    }

    const newServerNames = this.filterServers(Object.keys(serverMap));

    // Find added and removed servers
    const added = newServerNames.filter((name) => !currentServerNames.includes(name));
    const removed = currentServerNames.filter((name) => !newServerNames.includes(name));

    // Disconnect removed servers
    for (const name of removed) {
      await this.disconnectServer(name);
    }

    // Connect new servers
    for (const name of added) {
      const serverConfig = serverMap[name];
      if (serverConfig) {
        await this.connectServer(name, serverConfig);
      }
    }

    // Reconnect servers that may have changed config
    const existing = newServerNames.filter((name) => currentServerNames.includes(name));
    for (const name of existing) {
      const connection = this.connections.get(name);
      const newConfig = serverMap[name];

      // Check if config changed (command, args, env vars, OR rate limit)
      if (connection && newConfig) {
        const commandChanged = connection.command !== newConfig.command;
        const argsChanged = JSON.stringify(connection.args) !== JSON.stringify(newConfig.args || []);
        const envChanged = JSON.stringify(connection.env || {}) !== JSON.stringify(newConfig.env || {});
        const rateLimitChanged = JSON.stringify(connection.rateLimitConfig || null) !== JSON.stringify(newConfig.rateLimit || null);

        if (commandChanged || argsChanged || envChanged || rateLimitChanged) {
          logger.info(`Server config changed, reconnecting: ${name}`, {
            commandChanged,
            argsChanged,
            envChanged,
            rateLimitChanged,
          });
          await this.disconnectServer(name);
          await this.connectServer(name, newConfig);
        }
      }
    }

    if (added.length > 0 || removed.length > 0) {
      this.emit('serversChanged', added, removed);
    }

    logger.info('MCP Hub reload complete', { added, removed });
    return { added, removed };
  }

  /**
   * Shutdown all connections
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down MCP Hub');
    this.isShuttingDown = true;

    // Clear all pending reconnection timers
    for (const [_name, timer] of this.reconnectTimers) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    const disconnectPromises = Array.from(this.connections.keys()).map((name) =>
      this.disconnectServer(name)
    );

    await Promise.allSettled(disconnectPromises);

    this.connections.clear();
    this.toolCache.clear();

    // Clean up EventEmitter listeners
    this.removeAllListeners();

    logger.info('MCP Hub shutdown complete');
  }

  // ============================================
  // Public API for tool discovery and execution
  // ============================================

  /**
   * List all connected servers
   */
  listServers(): Array<{
    name: string;
    status: ServerStatus;
    toolCount: number;
    connectedAt?: Date;
    lastError?: string;
  }> {
    return Array.from(this.connections.values()).map((conn) => ({
      name: conn.name,
      status: conn.status,
      toolCount: conn.tools.length,
      connectedAt: conn.connectedAt,
      lastError: conn.lastError,
    }));
  }

  /**
   * Get tools for a specific server
   */
  getServerTools(serverName: string): Tool[] {
    return this.toolCache.get(serverName) || [];
  }

  /**
   * Get all tools from all servers
   */
  getAllTools(): Array<{ server: string; tool: Tool }> {
    const allTools: Array<{ server: string; tool: Tool }> = [];

    for (const [server, tools] of this.toolCache) {
      for (const tool of tools) {
        allTools.push({ server, tool });
      }
    }

    return allTools;
  }

  /**
   * Search for tools across all servers
   */
  searchTools(query: string): Array<{ server: string; tool: string; description: string }> {
    const results: Array<{ server: string; tool: string; description: string }> = [];
    const lowerQuery = query.toLowerCase();

    for (const [server, tools] of this.toolCache) {
      for (const tool of tools) {
        const nameMatch = tool.name.toLowerCase().includes(lowerQuery);
        const descMatch = tool.description?.toLowerCase().includes(lowerQuery);

        if (nameMatch || descMatch) {
          results.push({
            server,
            tool: tool.name,
            description: tool.description || '',
          });
        }
      }
    }

    return results;
  }

  /**
   * Call a tool on a specific server
   */
  async callTool(
    serverName: string,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const connection = this.connections.get(serverName);

    if (!connection) {
      throw new Error(`Server not found: ${serverName}`);
    }

    if (connection.status !== 'connected') {
      throw new Error(`Server not connected: ${serverName} (status: ${connection.status})`);
    }

    // Acquire rate limit token if rate limiter is configured
    if (connection.rateLimiter) {
      try {
        await connection.rateLimiter.acquire();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Rate limit for ${serverName}.${toolName}`, { error: errorMessage });
        throw error;
      }
    }

    try {
      const result = await connection.client.callTool({
        name: toolName,
        arguments: params,
      });

      // Extract content from result
      if (result.content && Array.isArray(result.content)) {
        // If there's structured content, prefer it
        if (result.structuredContent) {
          return result.structuredContent;
        }

        // Otherwise, try to parse text content as JSON
        const textContent = result.content.find((c) => c.type === 'text');
        if (textContent && 'text' in textContent) {
          try {
            return JSON.parse(textContent.text);
          } catch {
            return textContent.text;
          }
        }

        return result.content;
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Tool call failed: ${serverName}.${toolName}`, { error: errorMessage, params });
      throw new Error(`Tool call failed: ${serverName}.${toolName} - ${errorMessage}`);
    }
  }

  /**
   * Check if a server is connected
   */
  isServerConnected(serverName: string): boolean {
    const connection = this.connections.get(serverName);
    return connection?.status === 'connected';
  }

  /**
   * Get server count by status
   */
  getStats(): { total: number; connected: number; error: number; disconnected: number } {
    const connections = Array.from(this.connections.values());
    return {
      total: connections.length,
      connected: connections.filter((c) => c.status === 'connected').length,
      error: connections.filter((c) => c.status === 'error').length,
      disconnected: connections.filter((c) => c.status === 'disconnected').length,
    };
  }

  /**
   * Get the Claude config file path being used
   */
  getConfigPath(): string | null {
    return this.config.claudeConfigPath || findClaudeConfig();
  }

  /**
   * Get the conductor config file path being used
   */
  getConductorConfigPath(): string | null {
    return this.config.conductorConfigPath || findConductorConfig();
  }

  /**
   * Check if running in exclusive mode (conductor config only)
   */
  isExclusiveMode(): boolean {
    const conductorConfig = loadConductorConfig(this.config.conductorConfigPath || undefined);
    return (
      conductorConfig !== null &&
      conductorConfig.exclusive === true &&
      Object.keys(conductorConfig.servers || {}).length > 0
    );
  }

  /**
   * Get configuration info for status display
   */
  getConfigInfo(): {
    mode: 'exclusive' | 'shared' | 'claude-only';
    conductorConfigPath: string | null;
    claudeConfigPath: string | null;
    conductorServerCount: number;
    claudeServerCount: number;
  } {
    const conductorConfig = loadConductorConfig(this.config.conductorConfigPath || undefined);
    const claudeConfig = loadClaudeConfig(this.config.claudeConfigPath || undefined);

    const conductorServerCount = Object.keys(conductorConfig?.servers || {}).length;
    const claudeServerCount = Object.keys(claudeConfig?.mcpServers || {}).length;

    let mode: 'exclusive' | 'shared' | 'claude-only';
    if (conductorConfig && conductorConfig.exclusive && conductorServerCount > 0) {
      mode = 'exclusive';
    } else if (conductorServerCount > 0) {
      mode = 'shared';
    } else {
      mode = 'claude-only';
    }

    return {
      mode,
      conductorConfigPath: this.getConductorConfigPath(),
      claudeConfigPath: this.getConfigPath(),
      conductorServerCount,
      claudeServerCount,
    };
  }
}
