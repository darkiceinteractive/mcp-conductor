/**
 * Permissions utility for managing Claude Code MCP tool permissions
 *
 * This utility helps generate permission entries for MCP tools
 * and can update Claude's settings.json files.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger, safeJsonParse } from './index.js';

/**
 * Claude settings file structure
 */
export interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  [key: string]: unknown;
}

/**
 * Permission entry with metadata
 */
export interface PermissionEntry {
  permission: string;
  server: string;
  tool: string;
}

/**
 * Result of permission generation
 */
export interface PermissionGenerationResult {
  all: PermissionEntry[];
  new: PermissionEntry[];
  existing: PermissionEntry[];
}

/**
 * Settings scope for where to save permissions
 */
export type SettingsScope = 'user' | 'project';

/**
 * Get the path to Claude's user settings.json
 */
export function getUserSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

/**
 * Get the path to project-level settings.json
 */
export function getProjectSettingsPath(): string {
  return join(process.cwd(), '.claude', 'settings.json');
}

/**
 * Get settings file path based on scope
 */
export function getSettingsPath(scope: SettingsScope): string {
  return scope === 'user' ? getUserSettingsPath() : getProjectSettingsPath();
}

/**
 * Generate permission string for an MCP tool
 * Format: mcp__<server-name>__<tool-name>
 */
export function generatePermissionString(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * Parse a permission string into its components
 */
export function parsePermissionString(permission: string): { server: string; tool: string } | null {
  const match = permission.match(/^mcp__([^_]+)__(.+)$/);
  if (!match || !match[1] || !match[2]) return null;
  return { server: match[1], tool: match[2] };
}

/**
 * Load Claude settings from a file
 */
export function loadClaudeSettings(path: string): ClaudeSettings | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    return safeJsonParse<ClaudeSettings>(content, {});
  } catch (error) {
    logger.error(`Failed to load settings from ${path}`, { error: String(error) });
    return null;
  }
}

/**
 * Save Claude settings to a file
 */
export function saveClaudeSettings(path: string, settings: ClaudeSettings): boolean {
  try {
    // Ensure directory exists
    const dir = join(path, '..');
    if (!existsSync(dir)) {
      const { mkdirSync } = require('node:fs');
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    return true;
  } catch (error) {
    logger.error(`Failed to save settings to ${path}`, { error: String(error) });
    return false;
  }
}

/**
 * Get existing MCP permissions from settings
 */
export function getExistingPermissions(settings: ClaudeSettings): Set<string> {
  const existing = new Set<string>();
  const allowList = settings.permissions?.allow || [];

  for (const perm of allowList) {
    if (perm.startsWith('mcp__')) {
      existing.add(perm);
    }
  }

  return existing;
}

/**
 * Generate permission entries from server/tool list
 */
export function generatePermissionEntries(
  tools: Array<{ server: string; tool: string }>
): PermissionEntry[] {
  return tools.map(({ server, tool }) => ({
    permission: generatePermissionString(server, tool),
    server,
    tool,
  }));
}

/**
 * Compare generated permissions against existing ones
 */
export function comparePermissions(
  generated: PermissionEntry[],
  existing: Set<string>
): PermissionGenerationResult {
  const newPerms: PermissionEntry[] = [];
  const existingPerms: PermissionEntry[] = [];

  for (const entry of generated) {
    if (existing.has(entry.permission)) {
      existingPerms.push(entry);
    } else {
      newPerms.push(entry);
    }
  }

  return {
    all: generated,
    new: newPerms,
    existing: existingPerms,
  };
}

/**
 * Add permissions to settings
 */
export function addPermissionsToSettings(
  settings: ClaudeSettings,
  permissions: string[]
): ClaudeSettings {
  const updated = { ...settings };

  if (!updated.permissions) {
    updated.permissions = {};
  }
  if (!updated.permissions.allow) {
    updated.permissions.allow = [];
  }

  const existing = new Set(updated.permissions.allow);
  const toAdd = permissions.filter((p) => !existing.has(p));

  updated.permissions.allow = [...updated.permissions.allow, ...toAdd];

  return updated;
}

/**
 * Format permissions for display
 */
export function formatPermissionsForDisplay(entries: PermissionEntry[]): string {
  const byServer = new Map<string, string[]>();

  for (const entry of entries) {
    const tools = byServer.get(entry.server) || [];
    tools.push(entry.tool);
    byServer.set(entry.server, tools);
  }

  const lines: string[] = [];
  for (const [server, tools] of byServer) {
    lines.push(`\n${server}:`);
    for (const tool of tools.sort()) {
      lines.push(`  - ${tool}`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate JSON array of permission strings for copying
 */
export function formatPermissionsAsJson(entries: PermissionEntry[]): string {
  const permissions = entries.map((e) => e.permission).sort();
  return JSON.stringify(permissions, null, 2);
}
