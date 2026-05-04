/**
 * Persistent disk cache tier using CBOR encoding (cbor-x).
 *
 * Layout on disk:
 *   <diskDir>/<sha256-prefix-2>/<full-argsHash>.cbor
 *
 * TTL enforcement is the responsibility of the caller (CacheLayer). DiskCache
 * returns entries regardless of TTL so that stale-while-revalidate can be
 * handled at the CacheLayer level.
 *
 * Parallel writes are safe: each key maps to a unique path; writes are
 * atomic via a temp-file rename pattern.
 *
 * @module cache/disk
 */

import { readFile, writeFile, mkdir, readdir, stat, unlink, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { encode as cborEncode, decode as cborDecode } from 'cbor-x';
import { logger } from '../utils/index.js';
import type { CacheHit } from './index.js';

export interface DiskEntry {
  value: unknown;
  storedAt: number;
  ttlMs: number;
  server: string;
  tool: string;
}

/** Extended CacheHit that includes the stored TTL so CacheLayer can apply its own expiry policy. */
export interface DiskCacheHit extends CacheHit {
  ttlMs: number;
}

export interface DiskCacheOptions {
  diskDir: string;
  maxDiskBytes?: number;
}

const ROTATION_TARGET_RATIO = 0.8;

// B3: Validate a decoded CBOR value conforms to the DiskEntry schema.
// Returns true when the shape is valid, false when the entry should be
// discarded. Avoids throwing so callers can log + skip rather than crash.
function isValidDiskEntry(entry: unknown): entry is DiskEntry {
  if (entry === null || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e['storedAt'] === 'number' &&
    typeof e['ttlMs'] === 'number' &&
    typeof e['server'] === 'string' &&
    typeof e['tool'] === 'string' &&
    e['value'] !== undefined
  );
}

export class DiskCache {
  private diskDir: string;
  private maxDiskBytes: number;
  private hits = 0;
  private misses = 0;
  private bytesOnDisk = 0;
  private ready: Promise<void>;

  constructor(options: DiskCacheOptions) {
    this.diskDir = options.diskDir;
    this.maxDiskBytes = options.maxDiskBytes ?? 2 * 1024 * 1024 * 1024;
    this.ready = mkdir(this.diskDir, { recursive: true }).then(() => undefined);
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  private entryPath(argsHash: string): string {
    const prefix = argsHash.substring(0, 2);
    return join(this.diskDir, prefix, `${argsHash}.cbor`);
  }

  /**
   * Read an entry from disk.
   * Returns null only on genuine miss or read errors — TTL is NOT enforced here.
   * CacheLayer is responsible for staleness decisions (enabling SWR to work).
   */
  async get(argsHash: string): Promise<DiskCacheHit | null> {
    await this.ensureReady();
    const path = this.entryPath(argsHash);
    try {
      const buf = await readFile(path);
      const decoded = cborDecode(buf);
      // B3: Validate decoded shape before trusting it. A crafted .cbor file
      // in the cache directory must not be able to inject arbitrary data.
      if (!isValidDiskEntry(decoded)) {
        logger.warn('DiskCache: discarding malformed cache entry', { path });
        this.misses++;
        return null;
      }
      const entry: DiskEntry = decoded;
      this.hits++;
      return {
        value: entry.value,
        storedAt: entry.storedAt,
        source: 'disk',
        staleness: Date.now() - entry.storedAt,
        ttlMs: entry.ttlMs,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug('DiskCache: read error', { path, error: String(err) });
      }
      this.misses++;
      return null;
    }
  }

  /**
   * Write an entry to disk atomically (write to .tmp then rename).
   * Triggers rotation when over maxDiskBytes.
   */
  async set(argsHash: string, entry: DiskEntry): Promise<void> {
    await this.ensureReady();
    const path = this.entryPath(argsHash);
    const tmpPath = `${path}.tmp.${process.pid}`;
    await mkdir(dirname(path), { recursive: true });
    const buf = cborEncode(entry);
    await writeFile(tmpPath, buf);
    await rename(tmpPath, path);
    this.bytesOnDisk += buf.byteLength;
    if (this.bytesOnDisk > this.maxDiskBytes) {
      this.rotate().catch((err) =>
        logger.warn('DiskCache: rotation error', { error: String(err) })
      );
    }
  }

  async delete(argsHash: string): Promise<boolean> {
    await this.ensureReady();
    const path = this.entryPath(argsHash);
    try {
      const s = await stat(path);
      await unlink(path);
      this.bytesOnDisk = Math.max(0, this.bytesOnDisk - s.size);
      return true;
    } catch {
      return false;
    }
  }

  async invalidateByPrefix(serverToolPrefix: string): Promise<number> {
    await this.ensureReady();
    return this.scanAndDelete(async (entry, filePath) => {
      const entryKey = `${entry.server}:${entry.tool}`;
      const normalizedPrefix = serverToolPrefix.endsWith(':')
        ? serverToolPrefix.slice(0, -1)
        : serverToolPrefix;
      // Match: entryKey starts with prefix (handles server-only and server:tool prefixes)
      if (entryKey.startsWith(normalizedPrefix)) {
        try {
          const s = await stat(filePath);
          await unlink(filePath);
          this.bytesOnDisk = Math.max(0, this.bytesOnDisk - s.size);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    });
  }

  async invalidateServer(server: string): Promise<number> {
    await this.ensureReady();
    return this.scanAndDelete(async (entry, filePath) => {
      if (entry.server === server) {
        try {
          const s = await stat(filePath);
          await unlink(filePath);
          this.bytesOnDisk = Math.max(0, this.bytesOnDisk - s.size);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    });
  }

  async clear(): Promise<void> {
    await this.ensureReady();
    await this.scanAndDelete(async (_entry, filePath) => {
      try { await unlink(filePath); return true; } catch { return false; }
    });
    this.bytesOnDisk = 0;
  }

  get approximateBytesOnDisk(): number { return this.bytesOnDisk; }
  getCounters(): { hits: number; misses: number } { return { hits: this.hits, misses: this.misses }; }

  private async scanAndDelete(
    predicate: (entry: DiskEntry, filePath: string) => Promise<boolean>
  ): Promise<number> {
    let count = 0;
    let prefixDirs: string[];
    try { prefixDirs = await readdir(this.diskDir); } catch { return 0; }
    await Promise.all(prefixDirs.map(async (prefix) => {
      const prefixPath = join(this.diskDir, prefix);
      let files: string[];
      try {
        const s = await stat(prefixPath);
        if (!s.isDirectory()) return;
        files = await readdir(prefixPath);
      } catch { return; }
      await Promise.all(files.filter((f) => f.endsWith('.cbor')).map(async (f) => {
        const filePath = join(prefixPath, f);
        try {
          const buf = await readFile(filePath);
          const decoded = cborDecode(buf);
          // B3: Discard entries that don't match the DiskEntry schema.
          if (!isValidDiskEntry(decoded)) {
            logger.warn('DiskCache: discarding malformed cache entry in scan', { filePath });
            return;
          }
          const entry: DiskEntry = decoded;
          const deleted = await predicate(entry, filePath);
          if (deleted) count++;
        } catch { /* corrupt — skip */ }
      }));
    }));
    return count;
  }

  private async rotate(): Promise<void> {
    const target = Math.floor(this.maxDiskBytes * ROTATION_TARGET_RATIO);
    if (this.bytesOnDisk <= target) return;
    const entries: Array<{ filePath: string; storedAt: number; size: number }> = [];
    let prefixDirs: string[];
    try { prefixDirs = await readdir(this.diskDir); } catch { return; }
    await Promise.all(prefixDirs.map(async (prefix) => {
      const prefixPath = join(this.diskDir, prefix);
      let files: string[];
      try {
        const s = await stat(prefixPath);
        if (!s.isDirectory()) return;
        files = await readdir(prefixPath);
      } catch { return; }
      await Promise.all(files.filter((f) => f.endsWith('.cbor')).map(async (f) => {
        const filePath = join(prefixPath, f);
        try {
          const s = await stat(filePath);
          const buf = await readFile(filePath);
          const decoded = cborDecode(buf);
          // B3: Skip entries that don't match the DiskEntry schema during rotation.
          if (!isValidDiskEntry(decoded)) {
            logger.warn('DiskCache: discarding malformed cache entry in rotate', { filePath });
            return;
          }
          const entry: DiskEntry = decoded;
          entries.push({ filePath, storedAt: entry.storedAt, size: s.size });
        } catch { /* skip */ }
      }));
    }));
    entries.sort((a, b) => a.storedAt - b.storedAt);
    let freed = 0;
    const toFree = this.bytesOnDisk - target;
    for (const e of entries) {
      if (freed >= toFree) break;
      try {
        await unlink(e.filePath);
        freed += e.size;
        this.bytesOnDisk = Math.max(0, this.bytesOnDisk - e.size);
      } catch { /* concurrent delete — ok */ }
    }
    logger.debug('DiskCache: rotated', { freedBytes: freed });
  }
}
