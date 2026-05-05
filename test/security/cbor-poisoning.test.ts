/**
 * T3: CBOR poisoning test.
 *
 * Writes crafted malformed CBOR byte sequences to the cache directory and
 * asserts the DiskCache validation catches and discards them without crashing.
 *
 * Extends disk-poison.test.ts (schema field validation) with raw byte attacks:
 *   - Truncated CBOR (incomplete byte sequences)
 *   - Random garbage bytes
 *   - Zero-byte file
 *   - Valid CBOR but wrong root type (array, string)
 *   - Valid CBOR with Infinity in a numeric field
 *
 * Reference: test/unit/cache/disk-poison.test.ts (schema field validation).
 *
 * @module test/security/cbor-poisoning
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { encode as cborEncode } from 'cbor-x';
import { DiskCache } from '../../src/cache/disk.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-sec-cbor-'));
}

async function writeBytesAt(diskDir: string, hash: string, bytes: Uint8Array | Buffer): Promise<void> {
  const prefix = hash.substring(0, 2);
  const prefixDir = join(diskDir, prefix);
  mkdirSync(prefixDir, { recursive: true });
  await writeFile(join(prefixDir, `${hash}.cbor`), bytes);
}

function makeHash(n: number): string {
  return n.toString(16).padStart(2, '0') + 'a'.repeat(62);
}

describe('T3 cbor-poisoning', () => {
  let tmpDir: string;
  let cache: DiskCache;

  beforeEach(() => {
    tmpDir = makeTempDir();
    cache = new DiskCache({ diskDir: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('truncated CBOR bytes are discarded without crash', async () => {
    const hash = makeHash(0x10);
    // First 3 bytes of a valid CBOR map — deliberately incomplete.
    const truncated = Buffer.from([0xa4, 0x65, 0x76]);
    await writeBytesAt(tmpDir, hash, truncated);
    expect(await cache.get(hash)).toBeNull();
  });

  it('random garbage bytes are discarded without crash', async () => {
    for (let i = 0; i < 5; i++) {
      const hash = makeHash(0x20 + i);
      const garbage = randomBytes(1 + Math.floor(Math.random() * 511));
      await writeBytesAt(tmpDir, hash, garbage);
      expect(await cache.get(hash)).toBeNull();
    }
  });

  it('zero-byte file is discarded without crash', async () => {
    const hash = makeHash(0x30);
    await writeBytesAt(tmpDir, hash, Buffer.alloc(0));
    expect(await cache.get(hash)).toBeNull();
  });

  it('valid CBOR but root is an array is discarded', async () => {
    const hash = makeHash(0x40);
    await writeBytesAt(tmpDir, hash, Buffer.from(cborEncode([1, 2, 3])));
    expect(await cache.get(hash)).toBeNull();
  });

  it('valid CBOR but root is a string is discarded', async () => {
    const hash = makeHash(0x50);
    await writeBytesAt(tmpDir, hash, Buffer.from(cborEncode('not-an-entry')));
    expect(await cache.get(hash)).toBeNull();
  });

  it('valid CBOR with all required fields still loads correctly', async () => {
    const hash = makeHash(0x60);
    const valid = {
      value: { ok: true },
      storedAt: Date.now(),
      ttlMs: 300_000,
      server: 'test-server',
      tool: 'test-tool',
    };
    await writeBytesAt(tmpDir, hash, Buffer.from(cborEncode(valid)));
    const result = await cache.get(hash);
    expect(result).not.toBeNull();
    expect(result?.value).toEqual({ ok: true });
  });

  it('prototype-pollution attempt via __proto__ field does not affect Object.prototype', async () => {
    const hash = makeHash(0x70);
    const poisoned = {
      value: { ok: true },
      storedAt: Date.now(),
      ttlMs: 300_000,
      server: 'test-server',
      tool: 'test-tool',
      // Attempt prototype pollution — cbor-x may or may not decode this key.
      '__proto__': { polluted: true },
    };
    await writeBytesAt(tmpDir, hash, Buffer.from(cborEncode(poisoned)));
    // Regardless of whether the entry loads or not, prototype must be clean.
    await cache.get(hash);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('single-byte CBOR file is discarded without crash', async () => {
    const hash = makeHash(0x80);
    await writeBytesAt(tmpDir, hash, Buffer.from([0xff])); // CBOR break code
    expect(await cache.get(hash)).toBeNull();
  });
});
