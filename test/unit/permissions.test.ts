/**
 * Unit tests for permissions utility functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import {
  generatePermissionString,
  parsePermissionString,
  generatePermissionEntries,
  getExistingPermissions,
  comparePermissions,
  addPermissionsToSettings,
  formatPermissionsForDisplay,
  formatPermissionsAsJson,
  getUserSettingsPath,
  getProjectSettingsPath,
  type ClaudeSettings,
  type PermissionEntry,
} from '../../src/utils/permissions.js';

describe('Permissions Utility', () => {
  describe('generatePermissionString', () => {
    it('should generate correct permission string format', () => {
      expect(generatePermissionString('github', 'create_issue')).toBe('mcp__github__create_issue');
      expect(generatePermissionString('filesystem', 'read_file')).toBe('mcp__filesystem__read_file');
      expect(generatePermissionString('serena', 'get_current_config')).toBe('mcp__serena__get_current_config');
    });

    it('should handle server names with hyphens', () => {
      expect(generatePermissionString('mcp-conductor', 'execute_code')).toBe('mcp__mcp-conductor__execute_code');
      expect(generatePermissionString('taskmaster-ai', 'get_tasks')).toBe('mcp__taskmaster-ai__get_tasks');
    });
  });

  describe('parsePermissionString', () => {
    it('should parse valid permission strings', () => {
      expect(parsePermissionString('mcp__github__create_issue')).toEqual({
        server: 'github',
        tool: 'create_issue',
      });
      expect(parsePermissionString('mcp__filesystem__read_file')).toEqual({
        server: 'filesystem',
        tool: 'read_file',
      });
    });

    it('should handle tool names with underscores', () => {
      expect(parsePermissionString('mcp__github__create_pull_request')).toEqual({
        server: 'github',
        tool: 'create_pull_request',
      });
    });

    it('should return null for invalid permission strings', () => {
      expect(parsePermissionString('invalid')).toBeNull();
      expect(parsePermissionString('Read')).toBeNull();
      expect(parsePermissionString('Bash(git:*)')).toBeNull();
      expect(parsePermissionString('')).toBeNull();
    });
  });

  describe('generatePermissionEntries', () => {
    it('should generate entries from tool list', () => {
      const tools = [
        { server: 'github', tool: 'create_issue' },
        { server: 'filesystem', tool: 'read_file' },
      ];

      const entries = generatePermissionEntries(tools);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        permission: 'mcp__github__create_issue',
        server: 'github',
        tool: 'create_issue',
      });
      expect(entries[1]).toEqual({
        permission: 'mcp__filesystem__read_file',
        server: 'filesystem',
        tool: 'read_file',
      });
    });

    it('should handle empty input', () => {
      expect(generatePermissionEntries([])).toEqual([]);
    });
  });

  describe('getExistingPermissions', () => {
    it('should extract MCP permissions from settings', () => {
      const settings: ClaudeSettings = {
        permissions: {
          allow: [
            'Read',
            'Write',
            'mcp__github__create_issue',
            'mcp__filesystem__read_file',
            'Bash',
          ],
        },
      };

      const existing = getExistingPermissions(settings);

      expect(existing.size).toBe(2);
      expect(existing.has('mcp__github__create_issue')).toBe(true);
      expect(existing.has('mcp__filesystem__read_file')).toBe(true);
      expect(existing.has('Read')).toBe(false);
    });

    it('should handle empty permissions', () => {
      const settings: ClaudeSettings = {};
      expect(getExistingPermissions(settings).size).toBe(0);
    });

    it('should handle missing allow list', () => {
      const settings: ClaudeSettings = { permissions: {} };
      expect(getExistingPermissions(settings).size).toBe(0);
    });
  });

  describe('comparePermissions', () => {
    it('should identify new and existing permissions', () => {
      const generated: PermissionEntry[] = [
        { permission: 'mcp__github__create_issue', server: 'github', tool: 'create_issue' },
        { permission: 'mcp__github__list_issues', server: 'github', tool: 'list_issues' },
        { permission: 'mcp__serena__get_config', server: 'serena', tool: 'get_config' },
      ];

      const existing = new Set(['mcp__github__create_issue']);

      const result = comparePermissions(generated, existing);

      expect(result.all).toHaveLength(3);
      expect(result.existing).toHaveLength(1);
      expect(result.new).toHaveLength(2);
      expect(result.existing[0]?.permission).toBe('mcp__github__create_issue');
      expect(result.new.map(e => e.permission)).toContain('mcp__github__list_issues');
      expect(result.new.map(e => e.permission)).toContain('mcp__serena__get_config');
    });

    it('should handle all new permissions', () => {
      const generated: PermissionEntry[] = [
        { permission: 'mcp__serena__get_config', server: 'serena', tool: 'get_config' },
      ];

      const result = comparePermissions(generated, new Set());

      expect(result.new).toHaveLength(1);
      expect(result.existing).toHaveLength(0);
    });

    it('should handle all existing permissions', () => {
      const generated: PermissionEntry[] = [
        { permission: 'mcp__github__create_issue', server: 'github', tool: 'create_issue' },
      ];

      const existing = new Set(['mcp__github__create_issue']);
      const result = comparePermissions(generated, existing);

      expect(result.new).toHaveLength(0);
      expect(result.existing).toHaveLength(1);
    });
  });

  describe('addPermissionsToSettings', () => {
    it('should add new permissions to existing allow list', () => {
      const settings: ClaudeSettings = {
        permissions: {
          allow: ['Read', 'Write'],
          deny: [],
        },
      };

      const updated = addPermissionsToSettings(settings, [
        'mcp__github__create_issue',
        'mcp__serena__get_config',
      ]);

      expect(updated.permissions?.allow).toHaveLength(4);
      expect(updated.permissions?.allow).toContain('Read');
      expect(updated.permissions?.allow).toContain('mcp__github__create_issue');
      expect(updated.permissions?.allow).toContain('mcp__serena__get_config');
    });

    it('should not add duplicate permissions', () => {
      const settings: ClaudeSettings = {
        permissions: {
          allow: ['mcp__github__create_issue'],
        },
      };

      const updated = addPermissionsToSettings(settings, ['mcp__github__create_issue']);

      expect(updated.permissions?.allow).toHaveLength(1);
    });

    it('should create permissions structure if missing', () => {
      const settings: ClaudeSettings = {};

      const updated = addPermissionsToSettings(settings, ['mcp__github__create_issue']);

      expect(updated.permissions?.allow).toContain('mcp__github__create_issue');
    });

    it('should preserve other settings', () => {
      const settings: ClaudeSettings = {
        cleanupPeriodDays: 90,
        permissions: {
          allow: ['Read'],
          deny: ['Bash(rm:*)'],
          ask: ['ExitPlanMode'],
        },
      };

      const updated = addPermissionsToSettings(settings, ['mcp__github__create_issue']);

      expect(updated.cleanupPeriodDays).toBe(90);
      expect(updated.permissions?.deny).toContain('Bash(rm:*)');
      expect(updated.permissions?.ask).toContain('ExitPlanMode');
    });
  });

  describe('formatPermissionsForDisplay', () => {
    it('should group permissions by server', () => {
      const entries: PermissionEntry[] = [
        { permission: 'mcp__github__create_issue', server: 'github', tool: 'create_issue' },
        { permission: 'mcp__github__list_issues', server: 'github', tool: 'list_issues' },
        { permission: 'mcp__serena__get_config', server: 'serena', tool: 'get_config' },
      ];

      const output = formatPermissionsForDisplay(entries);

      expect(output).toContain('github:');
      expect(output).toContain('serena:');
      expect(output).toContain('- create_issue');
      expect(output).toContain('- list_issues');
      expect(output).toContain('- get_config');
    });

    it('should handle empty entries', () => {
      expect(formatPermissionsForDisplay([])).toBe('');
    });
  });

  describe('formatPermissionsAsJson', () => {
    it('should format as sorted JSON array', () => {
      const entries: PermissionEntry[] = [
        { permission: 'mcp__serena__get_config', server: 'serena', tool: 'get_config' },
        { permission: 'mcp__github__create_issue', server: 'github', tool: 'create_issue' },
      ];

      const json = formatPermissionsAsJson(entries);
      const parsed = JSON.parse(json);

      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toBe('mcp__github__create_issue');
      expect(parsed[1]).toBe('mcp__serena__get_config');
    });

    it('should handle empty entries', () => {
      expect(JSON.parse(formatPermissionsAsJson([]))).toEqual([]);
    });
  });

  describe('Path helpers', () => {
    it('should return user settings path in home directory', () => {
      const path = getUserSettingsPath();
      expect(path).toContain('.claude');
      expect(path).toContain('settings.json');
    });

    it('should return project settings path in current directory', () => {
      const path = getProjectSettingsPath();
      expect(path).toContain('.claude');
      expect(path).toContain('settings.json');
    });
  });
});
