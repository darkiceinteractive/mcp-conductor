/**
 * B3: CBOR disk cache schema validation tests.
 *
 * Verifies that crafted .cbor files (with wrong field types or missing fields)
 * are discarded with a warning rather than passed downstream as valid entries.
 * Valid entries must still load correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { encode as cborEncode } from 'cbor-x';
import { DiskCache } from '../../../src/cache/disk.js';
import type { DiskEntry } from '../../../src/cache/disk.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-b3-test-'));
}

/** Write a raw CBOR file directly to the cache directory at the expected path. */
async function writePoisonEntry(diskDir: string, argsHash: string, payload: unknown): Promise<void> {
  const prefix = argsHash.substring(0, 2);
  const prefixDir = join(diskDir, prefix);
  mkdirSync(prefixDir, { recursive: true });
  const filePath = join(prefixDir, `${argsHash}.cbor`);
  await writeFile(filePath, cborEncode(payload));
}

const VALID_HASH = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const VALID_ENTRY: DiskEntry = {
  value: { result: 'ok', count: 42 },
  storedAt: Date.now() - 1000,
  ttlMs: 300_000,
  server: 'test-server',
  tool: 'test-tool',
};

// ---------------------------------------------------------------------------
// B3: Schema validation tests
// ---------------------------------------------------------------------------

describe('B3: DiskCache CBOR schema validation', () => {
  let dir: string;
  let cache: DiskCache;

  beforeEach(() => {
    dir = makeTempDir();
    cache = new DiskCache({ diskDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('valid entry loads correctly', async () => {
    await writePoisonEntry(dir, VALID_HASH, VALID_ENTRY);
    const result = await cache.get(VALID_HASH);
    expect(result).not.toBeNull();
    expect(result?.value).toEqual(VALID_ENTRY.value);
    expect(result?.source).toBe('disk');
  });

  it('entry with storedAt as string is discarded and returns null', async () => {
    const hash = 'bb' + VALID_HASH.slice(2);
    await writePoisonEntry(dir, hash, {
      ...VALID_ENTRY,
      storedAt: '2026-01-01T00:00:00Z', // should be number
    });
    const result = await cache.get(hash);
    expect(result).toBeNull();
  });

  it('entry missing server field is discarded and returns null', async () => {
    const hash = 'cc' + VALID_HASH.slice(2);
    const { server: _dropped, ...withoutServer } = VALID_ENTRY;
    await writePoisonEntry(dir, hash, withoutServer);
    const result = await cache.get(hash);
    expect(result).toBeNull();
  });

  it('entry missing tool field is discarded and returns null', async () => {
    const hash = 'dd' + VALID_HASH.slice(2);
    const { tool: _dropped, ...withoutTool } = VALID_ENTRY;
    await writePoisonEntry(dir, hash, withoutTool);
    const result = await cache.get(hash);
    expect(result).toBeNull();
  });

  it('entry with value key absent is discarded and returns null', async () => {
    const hash = 'ee' + VALID_HASH.slice(2);
    const { value: _dropped, ...withoutValue } = VALID_ENTRY;
    await writePoisonEntry(dir, hash, withoutValue);
    const result = await cache.get(hash);
    expect(result).toBeNull();
  });

  it('entry with ttlMs as string is discarded and returns null', async () => {
    const hash = 'ff' + VALID_HASH.slice(2);
    await writePoisonEntry(dir, hash, {
      ...VALID_ENTRY,
      ttlMs: 'infinite', // should be number
    });
    const result = await cache.get(hash);
    expect(result).toBeNull();
  });

  it('entry where root is a string (not object) is discarded', async () => {
    const hash = '11' + VALID_HASH.slice(2);
    await writePoisonEntry(dir, hash, 'this-is-not-an-entry');
    const result = await cache.get(hash);
    expect(result).toBeNull();
  });

  it('entry where root is null is discarded', async () => {
    const hash = '22' + VALID_HASH.slice(2);
    await writePoisonEntry(dir, hash, null);
    const result = await cache.get(hash);
    expect(result).toBeNull();
  });

  it('entry where root is an array is discarded', async () => {
    const hash = '33' + VALID_HASH.slice(2);
    await writePoisonEntry(dir, hash, [1, 2, 3]);
    const result = await cache.get(hash);
    expect(result).toBeNull();
  });

  it('valid entries are not affected by invalid entries in the same prefix dir', async () => {
    // Write a valid entry and a poisoned entry that share the same 2-char prefix.
    const validHash = 'aa' + '0'.repeat(62);
    const poisonHash = 'aa' + '1'.repeat(62);

    await writePoisonEntry(dir, validHash, VALID_ENTRY);
    await writePoisonEntry(dir, poisonHash, { ...VALID_ENTRY, storedAt: 'bad' });

    const validResult = await cache.get(validHash);
    const poisonResult = await cache.get(poisonHash);

    expect(validResult).not.toBeNull();
    expect(validResult?.value).toEqual(VALID_ENTRY.value);
    expect(poisonResult).toBeNull();
  });
});
