/**
 * Bridge Session Registry
 *
 * Tracks `Mcp-Session-Id` values issued by the HTTP bridge. Sessions are
 * generated on first request (or when a client presents an unknown id) and
 * expire after a period of inactivity. Bounded to prevent unbounded growth
 * if a misbehaving client rotates IDs.
 *
 * Per MCP spec 2025-03-26 Streamable HTTP transport:
 * - session IDs MUST be globally unique and cryptographically secure
 * - requests carrying a terminated / unknown id should return 404
 * - servers MAY assign a new id on any request
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../utils/index.js';
import { LIFECYCLE_TIMEOUTS, MAX_BRIDGE_SESSIONS } from '../config/defaults.js';

interface SessionRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly ttlMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly maxSessions: number;

  constructor(opts?: {
    ttlMs?: number;
    cleanupIntervalMs?: number;
    maxSessions?: number;
  }) {
    this.ttlMs = opts?.ttlMs ?? LIFECYCLE_TIMEOUTS.BRIDGE_SESSION_TTL_MS;
    this.cleanupIntervalMs =
      opts?.cleanupIntervalMs ?? LIFECYCLE_TIMEOUTS.BRIDGE_SESSION_CLEANUP_INTERVAL_MS;
    this.maxSessions = opts?.maxSessions ?? MAX_BRIDGE_SESSIONS;
  }

  /**
   * Begin periodic cleanup. Called by HttpBridge.start().
   */
  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.sweep();
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  /**
   * Stop the cleanup timer and drop all sessions. Called by HttpBridge.stop().
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }

  /**
   * Create a new session and return its id.
   */
  create(): string {
    this.evictIfFull();
    const id = randomUUID();
    const now = Date.now();
    this.sessions.set(id, { id, createdAt: now, lastSeenAt: now });
    return id;
  }

  /**
   * Look up a session. Returns undefined if the id is unknown or expired.
   * Expired sessions are purged lazily here even if the sweep hasn't run yet.
   */
  touch(id: string): SessionRecord | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    const now = Date.now();
    if (now - record.lastSeenAt > this.ttlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    record.lastSeenAt = now;
    return record;
  }

  /**
   * Explicit termination (e.g. DELETE /session).
   * Returns true if a session was removed.
   */
  terminate(id: string): boolean {
    return this.sessions.delete(id);
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * Purge sessions older than ttlMs. Exposed for tests.
   */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, record] of this.sessions) {
      if (now - record.lastSeenAt > this.ttlMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug('Bridge session sweep', { removed, remaining: this.sessions.size });
    }
    return removed;
  }

  /**
   * If we're at capacity, drop the oldest (by lastSeenAt) record to make room.
   * Prevents unbounded growth under ID rotation.
   */
  private evictIfFull(): void {
    if (this.sessions.size < this.maxSessions) return;
    let oldestId: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [id, record] of this.sessions) {
      if (record.lastSeenAt < oldestSeen) {
        oldestSeen = record.lastSeenAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      this.sessions.delete(oldestId);
      logger.warn('Bridge session registry full, evicted oldest', { maxSessions: this.maxSessions });
    }
  }
}
