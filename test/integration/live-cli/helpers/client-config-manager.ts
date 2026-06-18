/**
 * Manages temporary MCP config injection for non-Claude AI clients.
 *
 * Each client stores its MCP server list in a different format/location:
 *   - Gemini:   ~/.gemini/settings.json   → mcpServers.<name>
 *   - Kimi:     ~/.kimi/mcp.json          → mcpServers.<name>
 *   - OpenCode: ~/.config/opencode/opencode.jsonc → mcp.<name>
 *
 * Inject before tests, restore after (in afterAll) using try/finally.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { resolve, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONDUCTOR_DIST = resolve(
  join(__dirname, '..', '..', '..', '..', 'dist', 'index.js')
);
const CONDUCTOR_CONFIG_PATH = '/Users/mattcrombie/.mcp-conductor.json';

const CONDUCTOR_SERVER_ENTRY = {
  command: 'node',
  args: [CONDUCTOR_DIST],
  env: { MCP_CONDUCTOR_CONFIG: CONDUCTOR_CONFIG_PATH },
};

export type SupportedClient = 'gemini' | 'kimi' | 'opencode';

export interface ConfigBackup {
  client: SupportedClient;
  path: string;
  /** Original file content as string, or null if the file did not exist */
  original: string | null;
}

const CLIENT_CONFIG_PATHS: Record<SupportedClient, string> = {
  gemini: `${homedir()}/.gemini/settings.json`,
  kimi: `${homedir()}/.kimi/mcp.json`,
  opencode: `${homedir()}/.config/opencode/opencode.jsonc`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  // Strip single-line // comments (for .jsonc files) before parsing
  const cleaned = raw.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([\]}])/g, '$1');
  return JSON.parse(cleaned);
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Per-client inject logic
// ---------------------------------------------------------------------------

async function injectGemini(backup: ConfigBackup): Promise<void> {
  let config: Record<string, unknown> = {};
  if (backup.original !== null) {
    try { config = JSON.parse(backup.original) as Record<string, unknown>; } catch { /* start fresh */ }
  }

  const mcpServers = (config['mcpServers'] as Record<string, unknown> | undefined) ?? {};
  mcpServers['mcp-conductor'] = CONDUCTOR_SERVER_ENTRY;
  config['mcpServers'] = mcpServers;

  await writeJsonFile(backup.path, config);
}

async function injectKimi(backup: ConfigBackup): Promise<void> {
  let config: Record<string, unknown> = { mcpServers: {} };
  if (backup.original !== null) {
    try { config = JSON.parse(backup.original) as Record<string, unknown>; } catch { /* start fresh */ }
  }

  const mcpServers = (config['mcpServers'] as Record<string, unknown> | undefined) ?? {};
  mcpServers['mcp-conductor'] = CONDUCTOR_SERVER_ENTRY;
  config['mcpServers'] = mcpServers;

  await writeJsonFile(backup.path, config);
}

async function injectOpenCode(backup: ConfigBackup): Promise<void> {
  let config: Record<string, unknown> = {};
  if (backup.original !== null) {
    // Strip jsonc comments before parsing
    const cleaned = backup.original
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,\s*([\]}])/g, '$1');
    try { config = JSON.parse(cleaned) as Record<string, unknown>; } catch { /* start fresh */ }
  }

  // OpenCode uses mcp.<name> with type/command/enabled structure
  const mcp = (config['mcp'] as Record<string, unknown> | undefined) ?? {};
  mcp['mcp-conductor'] = {
    type: 'local',
    command: ['node', CONDUCTOR_DIST],
    enabled: true,
    env: { MCP_CONDUCTOR_CONFIG: CONDUCTOR_CONFIG_PATH },
  };
  config['mcp'] = mcp;

  // Write as plain JSON (opencode accepts both jsonc and json)
  await writeJsonFile(backup.path, config);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the current config for each requested client, backs it up, then
 * writes the conductor entry into the config file.
 *
 * Returns backups that must be passed to restoreConfigs() in afterAll.
 */
export async function injectConductorConfig(
  clients: SupportedClient[]
): Promise<ConfigBackup[]> {
  const backups: ConfigBackup[] = [];

  for (const client of clients) {
    const path = CLIENT_CONFIG_PATHS[client];
    let original: string | null = null;

    if (existsSync(path)) {
      original = await readFile(path, 'utf8');
    }

    const backup: ConfigBackup = { client, path, original };
    backups.push(backup);

    try {
      if (client === 'gemini') await injectGemini(backup);
      else if (client === 'kimi') await injectKimi(backup);
      else if (client === 'opencode') await injectOpenCode(backup);
    } catch (err) {
      console.warn(`[client-config-manager] Failed to inject config for ${client}:`, err);
    }
  }

  return backups;
}

/**
 * Restores each backed-up config file to its original state.
 * Call this in afterAll with try/finally to ensure cleanup even on failure.
 */
export async function restoreConfigs(backups: ConfigBackup[]): Promise<void> {
  for (const backup of backups) {
    try {
      if (backup.original === null) {
        // File didn't exist before — don't leave our injected version around
        // (we leave it in place to avoid breaking things, just log)
        console.warn(`[client-config-manager] ${backup.client}: no original to restore (file was created by inject)`);
      } else {
        await writeFile(backup.path, backup.original, 'utf8');
      }
    } catch (err) {
      console.error(`[client-config-manager] Failed to restore ${backup.client} config:`, err);
    }
  }
}
