/**
 * Configuration loader for MCP Executor
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { MCPExecutorConfig, ExecutionMode, ClaudeConfig, ConductorConfig } from './schema.js';
import { DEFAULT_CONFIG, DEFAULT_CONDUCTOR_CONFIG, ENV_VARS } from './defaults.js';
import { logger, safeJsonParse } from '../utils/index.js';

/**
 * Load configuration from environment variables
 */
function loadFromEnv(config: MCPExecutorConfig): MCPExecutorConfig {
  const env = process.env;

  const port = env[ENV_VARS.PORT];
  if (port) {
    config.bridge.port = parseInt(port, 10);
  }

  const mode = env[ENV_VARS.MODE];
  if (mode) {
    config.execution.mode = mode as ExecutionMode;
  }

  const timeout = env[ENV_VARS.TIMEOUT];
  if (timeout) {
    config.execution.defaultTimeoutMs = parseInt(timeout, 10);
  }

  const maxTimeout = env[ENV_VARS.MAX_TIMEOUT];
  if (maxTimeout) {
    config.execution.maxTimeoutMs = parseInt(maxTimeout, 10);
  }

  const skillsPath = env[ENV_VARS.SKILLS_PATH];
  if (skillsPath) {
    config.skills.path = skillsPath;
  }

  const watchConfig = env[ENV_VARS.WATCH_CONFIG];
  if (watchConfig) {
    config.hotReload.enabled = watchConfig === 'true';
  }

  const watchSkills = env[ENV_VARS.WATCH_SKILLS];
  if (watchSkills) {
    config.skills.watchForChanges = watchSkills === 'true';
  }

  const streamEnabled = env[ENV_VARS.STREAM_ENABLED];
  if (streamEnabled) {
    config.execution.streamingEnabled = streamEnabled === 'true';
  }

  const maxMemory = env[ENV_VARS.MAX_MEMORY_MB];
  if (maxMemory) {
    config.sandbox.maxMemoryMb = parseInt(maxMemory, 10);
  }

  const allowedServers = env[ENV_VARS.ALLOWED_SERVERS];
  if (allowedServers) {
    config.servers.allowList = allowedServers.split(',').map((s) => s.trim());
  }

  return config;
}

/**
 * Load configuration from a JSON file
 */
function loadFromFile(filePath: string): Partial<MCPExecutorConfig> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return safeJsonParse<Partial<MCPExecutorConfig>>(content, {});
  } catch (error) {
    logger.warn(`Failed to load config from ${filePath}`, { error: String(error) });
    return null;
  }
}

/**
 * Deep merge two config objects
 */
function deepMerge(target: MCPExecutorConfig, source: Partial<MCPExecutorConfig>): MCPExecutorConfig {
  const result = JSON.parse(JSON.stringify(target)) as MCPExecutorConfig;

  if (source.bridge) {
    result.bridge = { ...result.bridge, ...source.bridge };
  }
  if (source.execution) {
    result.execution = { ...result.execution, ...source.execution };
  }
  if (source.sandbox) {
    result.sandbox = { ...result.sandbox, ...source.sandbox };
  }
  if (source.skills) {
    result.skills = { ...result.skills, ...source.skills };
  }
  if (source.hotReload) {
    result.hotReload = { ...result.hotReload, ...source.hotReload };
  }
  if (source.metrics) {
    result.metrics = { ...result.metrics, ...source.metrics };
  }
  if (source.servers) {
    result.servers = { ...result.servers, ...source.servers };
  }

  return result;
}

/**
 * Get the default config file path
 */
export function getDefaultConfigPath(): string {
  return join(homedir(), '.mcp-executor', 'config.json');
}

/**
 * Load the full configuration
 */
export function loadConfig(configPath?: string): MCPExecutorConfig {
  let config: MCPExecutorConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // Load from file if specified or default location
  const envConfig = process.env[ENV_VARS.CONFIG];
  const filePath = configPath || envConfig || getDefaultConfigPath();
  const fileConfig = loadFromFile(filePath);
  if (fileConfig) {
    config = deepMerge(config, fileConfig);
    logger.debug(`Loaded config from ${filePath}`);
  }

  // Override with environment variables
  config = loadFromEnv(config);

  return config;
}

/**
 * Claude config file search paths (cross-platform)
 */
export function getClaudeConfigPaths(): string[] {
  const home = homedir();
  const paths = [
    // Claude Code settings (primary for Claude Code CLI)
    join(home, '.claude', 'settings.json'),
    // Claude Code configs
    join(home, '.claude.json'),
    join(home, 'Library', 'Application Support', 'Claude Code', 'claude_code_config.json'),
    join(home, 'Library', 'Application Support', 'Claude', 'claude_code_config.json'),
    // Claude Desktop configs
    join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    join(home, '.config', 'claude', 'claude_desktop_config.json'),
    // Linux XDG paths
    join(home, '.config', 'Claude Code', 'claude_code_config.json'),
    // Project local configs
    join(process.cwd(), 'claude_code_config.json'),
    join(process.cwd(), 'claude_desktop_config.json'),
  ];

  // Windows paths
  const appData = process.env['APPDATA'];
  if (process.platform === 'win32' && appData) {
    paths.push(join(appData, 'Claude', 'claude_desktop_config.json'));
  }

  return paths;
}

/**
 * Find the Claude config file
 *
 * Prefers files that contain an `mcpServers` key. If none do, falls back
 * to the first existing file in the search order.
 */
export function findClaudeConfig(): string | null {
  // Check environment variable first
  const envPath = process.env[ENV_VARS.CLAUDE_CONFIG];
  if (envPath && envPath !== 'auto' && existsSync(envPath)) {
    return envPath;
  }

  // Search standard paths — prefer files with mcpServers
  let firstExisting: string | null = null;

  for (const configPath of getClaudeConfigPaths()) {
    if (!existsSync(configPath)) continue;

    if (!firstExisting) {
      firstExisting = configPath;
    }

    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = safeJsonParse<Record<string, unknown>>(content, {});
      if (parsed.mcpServers && Object.keys(parsed.mcpServers as Record<string, unknown>).length > 0) {
        logger.debug(`Found Claude config with mcpServers at ${configPath}`);
        return configPath;
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (firstExisting) {
    logger.debug(`Found Claude config at ${firstExisting} (no mcpServers found in any config)`);
  }

  return firstExisting;
}

/**
 * Load Claude config and extract MCP servers
 */
export function loadClaudeConfig(configPath?: string): ClaudeConfig | null {
  const path = configPath || findClaudeConfig();
  if (!path) {
    logger.warn('No Claude config file found');
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const config = safeJsonParse<ClaudeConfig>(content, {});
    logger.info(`Loaded Claude config from ${path}`, {
      serverCount: Object.keys(config.mcpServers || {}).length,
    });
    return config;
  } catch (error) {
    logger.error(`Failed to load Claude config from ${path}`, { error: String(error) });
    return null;
  }
}

/**
 * Conductor config file search paths (cross-platform)
 */
export function getConductorConfigPaths(): string[] {
  const home = homedir();
  return [
    // Primary location
    join(home, '.mcp-conductor.json'),
    // Alternative in .claude directory
    join(home, '.claude', 'mcp-conductor.json'),
  ];
}

/**
 * Get the default conductor config path (for saving)
 */
export function getDefaultConductorConfigPath(): string {
  return join(homedir(), '.mcp-conductor.json');
}

/**
 * Find the conductor config file
 */
export function findConductorConfig(): string | null {
  // Check environment variable first
  const envPath = process.env[ENV_VARS.CONDUCTOR_CONFIG];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // Search standard paths
  for (const path of getConductorConfigPaths()) {
    if (existsSync(path)) {
      logger.debug(`Found conductor config at ${path}`);
      return path;
    }
  }

  return null;
}

/**
 * Load conductor config for exclusive mode
 */
export function loadConductorConfig(configPath?: string): ConductorConfig | null {
  const path = configPath || findConductorConfig();
  if (!path) {
    logger.debug('No conductor config file found');
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const config = safeJsonParse<ConductorConfig>(content, DEFAULT_CONDUCTOR_CONFIG);
    logger.info(`Loaded conductor config from ${path}`, {
      exclusive: config.exclusive,
      serverCount: Object.keys(config.servers || {}).length,
    });
    return config;
  } catch (error) {
    logger.error(`Failed to load conductor config from ${path}`, { error: String(error) });
    return null;
  }
}

/**
 * Save conductor config to file
 */
export function saveConductorConfig(
  config: ConductorConfig,
  configPath?: string
): { success: boolean; path: string; error?: string } {
  const path = configPath || getDefaultConductorConfigPath();

  try {
    // Ensure directory exists
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write config with pretty formatting
    const content = JSON.stringify(config, null, 2);
    writeFileSync(path, content, 'utf-8');

    logger.info(`Saved conductor config to ${path}`, {
      exclusive: config.exclusive,
      serverCount: Object.keys(config.servers || {}).length,
    });

    return { success: true, path };
  } catch (error) {
    const errorMsg = String(error);
    logger.error(`Failed to save conductor config to ${path}`, { error: errorMsg });
    return { success: false, path, error: errorMsg };
  }
}
