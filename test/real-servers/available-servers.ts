/**
 * Available Servers Detection
 *
 * Detects which MCP servers are available for testing.
 * Used to conditionally run tests based on server availability.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

export interface ServerAvailability {
  name: string;
  available: boolean;
  reason?: string;
  command?: string;
  args?: string[];
}

export interface AvailableServersResult {
  testEcho: ServerAvailability;
  userServers: ServerAvailability[];
  allAvailable: string[];
}

// Cache for server availability
let cachedResult: AvailableServersResult | null = null;

/**
 * Get paths where Claude config might be located
 */
function getClaudeConfigPaths(): string[] {
  const home = homedir();
  return [
    process.env.MCP_EXECUTOR_CLAUDE_CONFIG,
    path.join(home, '.config', 'claude-code', 'mcp.json'),
    path.join(home, '.claude.json'),
    path.join(home, 'Library', 'Application Support', 'Claude Code', 'claude_code_config.json'),
    path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    path.join(home, '.config', 'claude', 'claude_desktop_config.json'),
  ].filter(Boolean) as string[];
}

/**
 * Find and load user's Claude config
 */
function loadUserClaudeConfig(): Record<string, unknown> | null {
  for (const configPath of getClaudeConfigPaths()) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        // Continue to next path
      }
    }
  }
  return null;
}

/**
 * Detect available MCP servers
 */
export async function detectAvailableServers(): Promise<AvailableServersResult> {
  // Return cached result if available
  if (cachedResult) {
    return cachedResult;
  }

  const result: AvailableServersResult = {
    testEcho: {
      name: 'test-echo',
      available: true,
      reason: 'Built-in test server',
      command: 'npx',
      args: ['tsx', 'test/real-servers/test-echo-server/index.ts'],
    },
    userServers: [],
    allAvailable: ['test-echo'],
  };

  // Try to load user's Claude config
  const userConfig = loadUserClaudeConfig();

  if (userConfig && typeof userConfig === 'object' && 'mcpServers' in userConfig) {
    const mcpServers = userConfig.mcpServers as Record<
      string,
      { command: string; args?: string[] }
    >;

    for (const [name, config] of Object.entries(mcpServers)) {
      // Skip self-references
      if (name === 'mcp-conductor' || name === 'mcp-executor') {
        continue;
      }

      const serverInfo: ServerAvailability = {
        name,
        available: true,
        reason: 'Found in user Claude config',
        command: config.command,
        args: config.args,
      };

      result.userServers.push(serverInfo);
      result.allAvailable.push(name);
    }
  }

  cachedResult = result;
  return result;
}

/**
 * Check if a specific server is available
 */
export async function isServerAvailable(name: string): Promise<boolean> {
  const servers = await detectAvailableServers();
  return servers.allAvailable.includes(name);
}

/**
 * Get server configuration if available
 */
export async function getServerConfig(
  name: string
): Promise<{ command: string; args?: string[] } | null> {
  const servers = await detectAvailableServers();

  if (name === 'test-echo') {
    return {
      command: servers.testEcho.command!,
      args: servers.testEcho.args,
    };
  }

  const userServer = servers.userServers.find((s) => s.name === name);
  if (userServer?.available) {
    return {
      command: userServer.command!,
      args: userServer.args,
    };
  }

  return null;
}

/**
 * Clear cached server availability (for testing)
 */
export function clearServerCache(): void {
  cachedResult = null;
}

/**
 * Check if any real servers (besides test-echo) are available
 */
export async function hasRealServers(): Promise<boolean> {
  const servers = await detectAvailableServers();
  return servers.userServers.length > 0;
}

/**
 * Get list of available server names
 */
export async function getAvailableServerNames(): Promise<string[]> {
  const servers = await detectAvailableServers();
  return servers.allAvailable;
}
