/**
 * MED-1 TOCTOU regression tests — daemon auth file loading.
 *
 * Covers the fix that replaced `existsSync + readFileSync` with a direct
 * `readFileSync` inside try/catch in both server.ts and client.ts.
 *
 * Test matrix:
 *   Server (loadOrCreateSecret):
 *     1. File exists with valid JSON  → loads sharedSecret correctly (no throw)
 *     2. File does not exist           → generates new secret (no throw)
 *     3. File exists with invalid JSON → throws SyntaxError (NOT silently regenerated)
 *     4. Race simulation: file deleted between write and read → ENOENT treated as
 *        not-found, generates new secret (no throw)
 *
 *   Client (loadSecret):
 *     5. File exists with valid JSON  → loads sharedSecret correctly (no throw)
 *     6. File does not exist (ENOENT) → throws user-friendly "start the daemon" message
 *     7. File exists with invalid JSON → throws SyntaxError (not silently skipped)
 *     8. Race simulation: file deleted before constructor runs → same user-friendly
 *        ENOENT message, not a raw fs error
 *     9. Non-ENOENT fs error (reading a directory path) → propagates; does NOT
 *        produce the "start the daemon" message
 */

import {
  describe, it, expect,
} from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadOrCreateSecret } from '../../../src/daemon/server.js';
import { DaemonClient } from '../../../src/daemon/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-toctou-test-'));
}

/** Write a well-formed auth file and return its path. */
function writeAuthFile(dir: string, secret: string): string {
  const authPath = join(dir, 'daemon-auth.json');
  writeFileSync(authPath, JSON.stringify({ sharedSecret: secret }), { mode: 0o600, encoding: 'utf-8' });
  return authPath;
}

// ---------------------------------------------------------------------------
// Server — loadOrCreateSecret (exercised via DaemonServer constructor)
// ---------------------------------------------------------------------------

// B4 note: DaemonServer's sharedSecretPath must resolve within CONDUCTOR_DIR
// (~/.mcp-conductor). Tests cannot write to that real directory, so tests 1-4
// call loadOrCreateSecret() directly (exported @internal) to verify its
// TOCTOU-safe behaviour without going through the B4 path guard.
describe('MED-1 server: loadOrCreateSecret TOCTOU fix', () => {
  it('1. loads sharedSecret when file exists with valid JSON', () => {
    const dir = makeTempDir();
    try {
      const authPath = join(dir, 'daemon-auth.json');
      writeFileSync(authPath, JSON.stringify({ sharedSecret: 'known-secret-value-abc123' }), { mode: 0o600, encoding: 'utf-8' });
      const secret = loadOrCreateSecret(authPath);
      expect(secret).toBe('known-secret-value-abc123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2. generates a new secret when the auth file does not exist (no throw)', () => {
    const dir = makeTempDir();
    try {
      const authPath = join(dir, 'daemon-auth.json');
      // File does not exist → should generate and return a new secret without throwing.
      const secret = loadOrCreateSecret(authPath);
      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3. throws SyntaxError (does NOT silently regenerate) when auth file has invalid JSON', () => {
    const dir = makeTempDir();
    try {
      const authPath = join(dir, 'daemon-auth.json');
      writeFileSync(authPath, 'NOT_VALID_JSON', { mode: 0o600, encoding: 'utf-8' });
      expect(() => loadOrCreateSecret(authPath)).toThrow(SyntaxError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4. race simulation: file deleted just before readFileSync → ENOENT treated as not-found, generates new secret', () => {
    const dir = makeTempDir();
    try {
      // Write a valid auth file then delete it to simulate the TOCTOU race window.
      const authPath = join(dir, 'daemon-auth.json');
      writeFileSync(authPath, JSON.stringify({ sharedSecret: 'will-be-deleted' }), { mode: 0o600, encoding: 'utf-8' });
      unlinkSync(authPath);

      // Under the old existsSync + readFileSync pattern existsSync returned false
      // and the function wouldn't even try to read. Under the new try/catch pattern
      // the ENOENT from readFileSync must be caught and treated as not-found
      // → generate a new secret without throwing.
      const secret = loadOrCreateSecret(authPath);
      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Client — loadSecret (exercised via DaemonClient constructor)
// ---------------------------------------------------------------------------

describe('MED-1 client: loadSecret TOCTOU fix', () => {
  it('5. loads sharedSecret when file exists with valid JSON', () => {
    const dir = makeTempDir();
    try {
      const authPath = writeAuthFile(dir, 'client-secret-abc123');
      expect(() => new DaemonClient({
        socketPath: join(dir, 'daemon.sock'),
        auth: { sharedSecretPath: authPath },
      })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6. throws a user-friendly error when the auth file does not exist', () => {
    const dir = makeTempDir();
    try {
      const authPath = join(dir, 'daemon-auth.json'); // file never written
      expect(() => new DaemonClient({
        socketPath: join(dir, 'daemon.sock'),
        auth: { sharedSecretPath: authPath },
      })).toThrow('Start the daemon first');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7. throws SyntaxError (not silently skipped) when auth file has invalid JSON', () => {
    const dir = makeTempDir();
    try {
      const authPath = join(dir, 'daemon-auth.json');
      writeFileSync(authPath, 'NOT_VALID_JSON', { mode: 0o600, encoding: 'utf-8' });

      expect(() => new DaemonClient({
        socketPath: join(dir, 'daemon.sock'),
        auth: { sharedSecretPath: authPath },
      })).toThrow(SyntaxError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8. race simulation: file deleted just before readFileSync → user-friendly ENOENT message', () => {
    const dir = makeTempDir();
    try {
      // Write then immediately delete to simulate the race window.
      const authPath = writeAuthFile(dir, 'will-be-deleted');
      unlinkSync(authPath);

      // Must throw the user-friendly message, not a raw ENOENT stack trace.
      expect(() => new DaemonClient({
        socketPath: join(dir, 'daemon.sock'),
        auth: { sharedSecretPath: authPath },
      })).toThrow('Start the daemon first');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('9. non-ENOENT fs error propagates as-is (not wrapped in "start the daemon" message)', () => {
    const dir = makeTempDir();
    try {
      // Pointing authPath at a directory causes readFileSync to throw EISDIR
      // (not ENOENT) — this exercises the "re-throw non-ENOENT errors" branch.
      const authPath = join(dir, 'a-directory');
      mkdirSync(authPath);

      let thrownError: Error | undefined;
      try {
        new DaemonClient({
          socketPath: join(dir, 'daemon.sock'),
          auth: { sharedSecretPath: authPath },
        });
      } catch (err) {
        thrownError = err as Error;
      }

      expect(thrownError).toBeDefined();
      // Must NOT produce the "start the daemon" message for non-ENOENT errors.
      expect(thrownError!.message).not.toContain('Start the daemon first');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
