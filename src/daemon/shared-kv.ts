/**
 * Shared Key-Value Store for MCP Conductor Daemon.
 *
 * Provides in-memory storage with optional disk persistence and TTL support.
 * Each KV entry can carry an expiry timestamp; a background sweep runs every
 * 30 s to evict stale entries and sync the on-disk snapshot.
 *
 * @module daemon/shared-kv
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

/** Options accepted by {@link SharedKV.set}. */
export interface KVSetOptions {
  /** Time-to-live in milliseconds. Entry is deleted after this duration. */
  ttl?: number;
}

/** Internal storage entry. */
interface KVEntry<T = unknown> {
  value: T;
  /** Absolute epoch ms at which the entry expires, or undefined for no expiry. */
  expiresAt?: number;
}

/** Snapshot format written to disk. */
interface KVSnapshot {
  version: 1;
  entries: Record<string, KVEntry>;
}

/** Options for constructing a {@link SharedKV} instance. */
export interface SharedKVOptions {
  /** Directory for disk persistence. Defaults to `~/.mcp-conductor/kv/`. */
  persistDir?: string;
  /** Sweep interval for TTL expiry, in milliseconds. Defaults to 30 000. */
  sweepIntervalMs?: number;
  /** Namespace / shard name used for the snapshot file. Defaults to `default`. */
  namespace?: string;
  /** Whether to skip loading from disk on construction. Useful in tests. */
  skipLoad?: boolean;
}

/**
 * Shared key-value store with TTL expiry and disk persistence.
 *
 * Thread-safety note: Node.js is single-threaded; all mutations are
 * synchronous operations on the in-memory Map, so no locking is required
 * within a single process. Cross-process sharing is handled by the daemon
 * server, which owns a single SharedKV instance.
 */
export class SharedKV {
  private readonly store = new Map<string, KVEntry>();
  private readonly persistDir: string;
  private readonly snapshotPath: string;
  private readonly sweepIntervalMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(options: SharedKVOptions = {}) {
    this.persistDir = options.persistDir ?? join(homedir(), '.mcp-conductor', 'kv');
    this.sweepIntervalMs = options.sweepIntervalMs ?? 30_000;
    const ns = options.namespace ?? 'default';
    this.snapshotPath = join(this.persistDir, `${ns}.json`);

    if (!options.skipLoad) {
      this.loadFromDisk();
    }
    this.startSweep();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Retrieve a value by key.
   * Returns `null` if the key does not exist or has expired.
   */
  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.dirty = true;
      return null;
    }

    return entry.value as T;
  }

  /**
   * Store a value, with an optional TTL.
   */
  set<T>(key: string, value: T, options?: KVSetOptions): void {
    const entry: KVEntry<T> = { value };
    if (options?.ttl !== undefined && options.ttl > 0) {
      entry.expiresAt = Date.now() + options.ttl;
    }
    this.store.set(key, entry as KVEntry);
    this.dirty = true;
  }

  /**
   * Delete a key. No-op if the key does not exist.
   */
  delete(key: string): void {
    if (this.store.delete(key)) {
      this.dirty = true;
    }
  }

  /**
   * List all non-expired keys, optionally filtered by a string prefix.
   */
  list(prefix?: string): string[] {
    const now = Date.now();
    const keys: string[] = [];
    for (const [k, entry] of this.store) {
      if (entry.expiresAt !== undefined && now > entry.expiresAt) continue;
      if (prefix === undefined || k.startsWith(prefix)) {
        keys.push(k);
      }
    }
    return keys.sort();
  }

  /**
   * Remove all entries (optionally matching a prefix).
   */
  clear(prefix?: string): void {
    if (prefix === undefined) {
      this.store.clear();
    } else {
      for (const k of this.store.keys()) {
        if (k.startsWith(prefix)) this.store.delete(k);
      }
    }
    this.dirty = true;
  }

  /** Total number of (potentially expired) entries currently held in memory. */
  get size(): number {
    return this.store.size;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Flush the in-memory state to disk and stop the sweep timer.
   * Call this before process exit or daemon shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.evictExpired();
    this.flushToDisk();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private loadFromDisk(): void {
    if (!existsSync(this.snapshotPath)) return;

    try {
      const raw = readFileSync(this.snapshotPath, 'utf-8');
      const snapshot = JSON.parse(raw) as KVSnapshot;
      if (snapshot.version !== 1) {
        logger.warn('SharedKV: unknown snapshot version, skipping load', { path: this.snapshotPath });
        return;
      }
      const now = Date.now();
      let loaded = 0;
      let skipped = 0;
      for (const [k, entry] of Object.entries(snapshot.entries)) {
        if (entry.expiresAt !== undefined && now > entry.expiresAt) {
          skipped++;
          continue; // already expired — do not restore
        }
        this.store.set(k, entry);
        loaded++;
      }
      logger.debug('SharedKV: loaded from disk', { loaded, skipped, path: this.snapshotPath });
    } catch (err) {
      logger.warn('SharedKV: failed to load snapshot', { error: String(err), path: this.snapshotPath });
    }
  }

  /** Write the current (non-expired) state to disk. */
  flushToDisk(): void {
    try {
      mkdirSync(this.persistDir, { recursive: true });
      const entries: Record<string, KVEntry> = {};
      const now = Date.now();
      for (const [k, entry] of this.store) {
        if (entry.expiresAt !== undefined && now > entry.expiresAt) continue;
        entries[k] = entry;
      }
      const snapshot: KVSnapshot = { version: 1, entries };
      writeFileSync(this.snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      logger.error('SharedKV: failed to flush to disk', { error: String(err), path: this.snapshotPath });
    }
  }

  // ---------------------------------------------------------------------------
  // TTL sweep
  // ---------------------------------------------------------------------------

  private startSweep(): void {
    this.sweepTimer = setInterval(() => {
      this.evictExpired();
      if (this.dirty) {
        this.flushToDisk();
      }
    }, this.sweepIntervalMs);

    // Allow the process to exit even if the timer is still running.
    if (this.sweepTimer.unref) {
      this.sweepTimer.unref();
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, entry] of this.store) {
      if (entry.expiresAt !== undefined && now > entry.expiresAt) {
        this.store.delete(k);
        this.dirty = true;
      }
    }
  }

  /**
   * Delete all snapshot files under `persistDir`.
   * Used in tests for clean-up between runs.
   */
  static clearAllSnapshots(persistDir: string): void {
    if (!existsSync(persistDir)) return;
    for (const f of readdirSync(persistDir)) {
      if (f.endsWith('.json')) {
        try { unlinkSync(join(persistDir, f)); } catch { /* ignore */ }
      }
    }
  }
}
