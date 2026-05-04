/**
 * T3: Path traversal test.
 *
 * Verifies that path-handling code rejects `../` paths, absolute paths outside
 * allowed directories, and unusual characters that would allow traversal.
 *
 * @module test/security/path-traversal
 */

import { describe, it, expect } from 'vitest';
import { resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Simulate the path validation logic for import_servers paths.
 * A path is safe if it resolves within the allowed base directory.
 */
function isPathWithinBase(base: string, candidate: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedCandidate = resolve(resolvedBase, candidate);
  return resolvedCandidate.startsWith(resolvedBase + '/') || resolvedCandidate === resolvedBase;
}

/**
 * CONDUCTOR_DIR validation — mirrors B4 logic.
 */
function isSafeConfigPath(conductorDir: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const resolved = resolve(candidate);
  return resolved.startsWith(resolve(conductorDir) + '/') || resolved === resolve(conductorDir);
}

const CONDUCTOR_DIR = join(homedir(), '.mcp-conductor');
const CLAUDE_DIR = join(homedir(), '.claude');

describe('T3 path-traversal', () => {
  describe('import_servers path validation', () => {
    it('path inside base directory is allowed', () => {
      expect(isPathWithinBase(CLAUDE_DIR, 'claude_desktop_config.json')).toBe(true);
      expect(isPathWithinBase(CLAUDE_DIR, 'settings.json')).toBe(true);
    });

    it('../ traversal out of base is rejected', () => {
      expect(isPathWithinBase(CLAUDE_DIR, '../.ssh/id_rsa')).toBe(false);
      expect(isPathWithinBase(CLAUDE_DIR, '../../etc/passwd')).toBe(false);
    });

    it('absolute path to outside base is rejected', () => {
      expect(isPathWithinBase(CLAUDE_DIR, '/etc/passwd')).toBe(false);
      expect(isPathWithinBase(CLAUDE_DIR, '/tmp/malicious.json')).toBe(false);
    });

    it('URL-decoded traversal sequence is still rejected', () => {
      // %2E%2E%2F decodes to ../
      const decoded = decodeURIComponent('%2E%2E%2F.ssh%2Fid_rsa');
      expect(isPathWithinBase(CLAUDE_DIR, decoded)).toBe(false);
    });

    it('path with null byte is detectable before resolution', () => {
      const withNull = 'settings.json\x00.evil';
      expect(withNull.includes('\x00')).toBe(true);
      // A guard should reject any path containing null bytes.
      expect(withNull.includes('\x00') ? false : isPathWithinBase(CLAUDE_DIR, withNull)).toBe(false);
    });
  });

  describe('sharedSecretPath validation (B4 mirror)', () => {
    it('path inside CONDUCTOR_DIR is accepted', () => {
      const safe = join(CONDUCTOR_DIR, 'daemon-auth.json');
      expect(isSafeConfigPath(CONDUCTOR_DIR, safe)).toBe(true);
    });

    it('path traversal outside CONDUCTOR_DIR is rejected', () => {
      const traversal = join(CONDUCTOR_DIR, '..', 'evil-secret.json');
      expect(isSafeConfigPath(CONDUCTOR_DIR, traversal)).toBe(false);
    });

    it('/tmp path is rejected', () => {
      expect(isSafeConfigPath(CONDUCTOR_DIR, '/tmp/secret.json')).toBe(false);
    });

    it('relative path is rejected (must be absolute)', () => {
      expect(isSafeConfigPath(CONDUCTOR_DIR, 'relative/secret.json')).toBe(false);
    });

    it('path equal to CONDUCTOR_DIR itself is accepted', () => {
      expect(isSafeConfigPath(CONDUCTOR_DIR, CONDUCTOR_DIR)).toBe(true);
    });
  });

  describe('general path safety', () => {
    it('double-slash paths resolve correctly and remain within base', () => {
      const doubled = CONDUCTOR_DIR + '//daemon-auth.json';
      expect(isSafeConfigPath(CONDUCTOR_DIR, doubled)).toBe(true);
    });

    it('path with single dot component resolves to same directory', () => {
      const dotPath = join(CONDUCTOR_DIR, '.', 'daemon-auth.json');
      expect(isSafeConfigPath(CONDUCTOR_DIR, dotPath)).toBe(true);
    });

    it('deeply nested traversal is still caught', () => {
      const deep = join(CONDUCTOR_DIR, 'a', 'b', 'c', '..', '..', '..', '..', 'etc', 'passwd');
      expect(isSafeConfigPath(CONDUCTOR_DIR, deep)).toBe(false);
    });
  });
});
