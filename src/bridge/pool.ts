/**
 * Backend Connection Pool
 *
 * Maintains persistent stdio connections to MCP backend servers, multiplexes
 * JSON-RPC requests over the same channel, and respawns crashed backends
 * within 1 second. Eliminates per-request spawn overhead.
 *
 * Design:
 * - Each server gets [min, max] connections whose lifecycle is managed here
 * - JSON-RPC multiplexing: requests tagged with a unique id; responses routed
 *   back to the correct in-flight caller via a pending-map
 * - Idle timer: connections unused for `idleTimeoutMs` are gracefully closed
 * - Crash recovery: `close` event triggers automatic respawn
 *
 * @module bridge/pool
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/index.js';
import type { ConnectionPoolConfig } from '../config/schema.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface PoolStats {
  totalConnections: number;
  idleConnections: number;
  busyConnections: number;
  serversTracked: number;
  pendingAcquires: number;
}

/** Opaque handle returned by `acquire()`. Pass back to `release()`. */
export interface PooledConnection {
  readonly id: string;
  readonly serverKey: string;
  /** Send a multiplexed JSON-RPC call; resolves with the parsed response. */
  call(method: string, params?: unknown): Promise<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal implementation
// ─────────────────────────────────────────────────────────────────────────────

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface InternalConnection {
  id: string;
  serverKey: string;
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
  /** Pending JSON-RPC calls keyed by request id */
  pending: Map<number, PendingCall>;
  nextRequestId: number;
  /** Buffered incomplete JSON chunks from the backend */
  lineBuffer: string;
  /** Write a raw line to the backend. null if connection is closed. */
  writeLine: ((line: string) => boolean) | null;
  /** Close the underlying transport */
  close: () => void;
  closed: boolean;
  createdAt: number;
}

interface WaitingAcquire {
  resolve: (conn: PooledConnection) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface ServerEntry {
  key: string;
  connections: Map<string, InternalConnection>;
  waiting: WaitingAcquire[];
  /** Factory that spawns a fresh stdio pair to the backend */
  factory: ConnectionFactory;
  /** Number of connections currently being created (not yet in `connections`) */
  spawning: number;
}

/**
 * Factory function that creates a new stdio channel to a backend.
 * Returns a send function and a closer; delivers received lines via callback.
 */
export type ConnectionFactory = (opts: {
  onLine: (line: string) => void;
  onClose: () => void;
  onError: (err: Error) => void;
}) => {
  write: (line: string) => boolean;
  close: () => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// ConnectionPool
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<ConnectionPoolConfig> = {
  minConnectionsPerServer: 1,
  maxConnectionsPerServer: 4,
  idleTimeoutMs: 300_000,
  acquireTimeoutMs: 5_000,
};

/**
 * A connection pool for MCP backend servers.
 *
 * Usage:
 * ```ts
 * pool.registerServer('my-server', factory);
 * const conn = await pool.acquire('my-server');
 * const result = await conn.call('tools/list');
 * pool.release(conn);
 * ```
 */
export class ConnectionPool extends EventEmitter {
  private readonly opts: Required<ConnectionPoolConfig>;
  private readonly servers: Map<string, ServerEntry> = new Map();
  private isShuttingDown = false;

  constructor(options: ConnectionPoolConfig = {}) {
    super();
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Register a backend server with its connection factory.
   * Call this before `acquire()`. Pre-warms `minConnectionsPerServer`
   * connections immediately.
   */
  registerServer(serverKey: string, factory: ConnectionFactory): void {
    if (this.servers.has(serverKey)) return;

    const entry: ServerEntry = {
      key: serverKey,
      connections: new Map(),
      waiting: [],
      factory,
      spawning: 0,
    };
    this.servers.set(serverKey, entry);

    // Pre-warm minimum connections
    for (let i = 0; i < this.opts.minConnectionsPerServer; i++) {
      this._spawnConnection(entry).catch((err) => {
        logger.warn('ConnectionPool: pre-warm spawn failed', { serverKey, err: String(err) });
      });
    }
  }

  /**
   * Acquire an idle connection for `serverKey`.
   *
   * If all connections are busy and count < max, spawns a new one.
   * If at max, waits up to `acquireTimeoutMs` for a release.
   */
  async acquire(serverKey: string): Promise<PooledConnection> {
    if (this.isShuttingDown) {
      throw new Error(`ConnectionPool is shutting down`);
    }

    const entry = this.servers.get(serverKey);
    if (!entry) {
      throw new Error(`ConnectionPool: unknown server "${serverKey}". Call registerServer() first.`);
    }

    // Try to find an idle connection
    const idle = this._findIdle(entry);
    if (idle) {
      return this._markBusy(idle);
    }

    // Spawn a new connection if under max
    const totalActive = entry.connections.size + entry.spawning;
    if (totalActive < this.opts.maxConnectionsPerServer) {
      const conn = await this._spawnConnection(entry);
      return this._markBusy(conn);
    }

    // All at max — wait for a release
    return new Promise<PooledConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = entry.waiting.indexOf(waiter);
        if (idx !== -1) entry.waiting.splice(idx, 1);
        reject(new Error(`ConnectionPool: acquire timeout after ${this.opts.acquireTimeoutMs}ms for "${serverKey}"`));
      }, this.opts.acquireTimeoutMs);

      // Allow the timer to be GC'd without blocking Node exit
      if (timer.unref) timer.unref();

      const waiter: WaitingAcquire = { resolve, reject, timer };
      entry.waiting.push(waiter);
    });
  }

  /**
   * Return a connection to the pool.
   * Idle timer is (re)started; if waiters are queued, hands off immediately.
   */
  release(connection: PooledConnection): void {
    const entry = this.servers.get(connection.serverKey);
    if (!entry) return;

    const internal = entry.connections.get(connection.id);
    if (!internal || internal.closed) return;

    internal.busy = false;

    // Drain waiting queue first
    if (entry.waiting.length > 0) {
      const waiter = entry.waiting.shift()!;
      clearTimeout(waiter.timer);
      // Mark busy synchronously before handing off
      internal.busy = true;
      waiter.resolve(this._toPublic(internal));
      return;
    }

    // Start idle timer
    this._startIdleTimer(entry, internal);
  }

  /** Gracefully drain all connections and stop accepting new ones. */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    for (const entry of this.servers.values()) {
      // Reject all waiting acquires
      for (const waiter of entry.waiting) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('ConnectionPool shut down'));
      }
      entry.waiting.length = 0;

      // Close all connections
      for (const conn of entry.connections.values()) {
        this._closeInternal(conn);
      }
    }

    this.servers.clear();
    logger.info('ConnectionPool: shut down complete');
  }

  /** Snapshot of pool health metrics. */
  stats(): PoolStats {
    let total = 0;
    let idle = 0;
    let busy = 0;
    let pending = 0;

    for (const entry of this.servers.values()) {
      for (const conn of entry.connections.values()) {
        if (conn.closed) continue;
        total++;
        if (conn.busy) busy++;
        else idle++;
      }
      pending += entry.waiting.length;
    }

    return {
      totalConnections: total,
      idleConnections: idle,
      busyConnections: busy,
      serversTracked: this.servers.size,
      pendingAcquires: pending,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  private _findIdle(entry: ServerEntry): InternalConnection | undefined {
    for (const conn of entry.connections.values()) {
      if (!conn.busy && !conn.closed) return conn;
    }
    return undefined;
  }

  private _markBusy(conn: InternalConnection): PooledConnection {
    conn.busy = true;
    // Cancel idle timer if active
    if (conn.idleTimer) {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = null;
    }
    return this._toPublic(conn);
  }

  private _toPublic(internal: InternalConnection): PooledConnection {
    return {
      id: internal.id,
      serverKey: internal.serverKey,
      call: (method: string, params?: unknown) => this._rpcCall(internal, method, params),
    };
  }

  private _rpcCall(conn: InternalConnection, method: string, params?: unknown): Promise<unknown> {
    if (conn.closed || !conn.writeLine) {
      return Promise.reject(new Error(`Connection ${conn.id} is closed`));
    }

    const id = conn.nextRequestId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });

    return new Promise<unknown>((resolve, reject) => {
      conn.pending.set(id, { resolve, reject });
      const ok = conn.writeLine!(message + '\n');
      if (!ok) {
        conn.pending.delete(id);
        reject(new Error(`Write failed on connection ${conn.id}`));
      }
    });
  }

  private async _spawnConnection(entry: ServerEntry): Promise<InternalConnection> {
    entry.spawning++;

    const id = `${entry.key}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const internal: InternalConnection = {
      id,
      serverKey: entry.key,
      busy: false,
      idleTimer: null,
      pending: new Map(),
      nextRequestId: 1,
      lineBuffer: '',
      writeLine: null,
      close: () => {},
      closed: false,
      createdAt: Date.now(),
    };

    return new Promise<InternalConnection>((resolve, reject) => {
      let resolved = false;

      const transport = entry.factory({
        onLine: (line: string) => this._handleLine(internal, line),
        onClose: () => this._handleClose(entry, internal),
        onError: (err: Error) => {
          if (!resolved) {
            resolved = true;
            entry.spawning--;
            entry.connections.delete(id);
            reject(err);
          } else {
            this._handleError(entry, internal, err);
          }
        },
      });

      internal.writeLine = transport.write;
      internal.close = transport.close;

      entry.connections.set(id, internal);
      entry.spawning--;
      resolved = true;

      logger.debug('ConnectionPool: spawned connection', { id, server: entry.key });
      resolve(internal);
    });
  }

  private _handleLine(conn: InternalConnection, raw: string): void {
    // Accumulate partial lines
    conn.lineBuffer += raw;

    // Process all complete newline-terminated JSON objects
    let nl: number;
    while ((nl = conn.lineBuffer.indexOf('\n')) !== -1) {
      const line = conn.lineBuffer.slice(0, nl).trim();
      conn.lineBuffer = conn.lineBuffer.slice(nl + 1);

      if (!line) continue;

      let msg: { id?: number; result?: unknown; error?: { message: string; code?: number } };
      try {
        msg = JSON.parse(line);
      } catch {
        logger.warn('ConnectionPool: unparseable line from backend', { conn: conn.id, line: line.slice(0, 200) });
        continue;
      }

      if (msg.id !== undefined) {
        const pending = conn.pending.get(msg.id);
        if (pending) {
          conn.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message ?? 'RPC error'));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    }
  }

  private _handleClose(entry: ServerEntry, conn: InternalConnection): void {
    if (conn.closed) return;
    conn.closed = true;
    conn.writeLine = null;

    // Reject all in-flight calls
    for (const [, pending] of conn.pending) {
      pending.reject(new Error(`Connection ${conn.id} to "${entry.key}" closed unexpectedly`));
    }
    conn.pending.clear();

    if (conn.idleTimer) {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = null;
    }

    entry.connections.delete(conn.id);
    logger.warn('ConnectionPool: connection closed', { id: conn.id, server: entry.key });

    if (this.isShuttingDown) return;

    // Respawn to maintain minimum floor
    const activeCount = entry.connections.size + entry.spawning;
    if (activeCount < this.opts.minConnectionsPerServer) {
      setTimeout(() => {
        if (!this.isShuttingDown) {
          this._spawnConnection(entry)
            .then((newConn) => {
              logger.info('ConnectionPool: respawned connection after crash', {
                newId: newConn.id,
                server: entry.key,
              });
              // Drain any waiters that accumulated during the crash
              this._drainWaiters(entry);
            })
            .catch((err) => {
              logger.error('ConnectionPool: respawn failed', { server: entry.key, err: String(err) });
            });
        }
      }, 0).unref?.();
    }

    this.emit('connectionClosed', entry.key, conn.id);
  }

  private _handleError(entry: ServerEntry, conn: InternalConnection, err: Error): void {
    logger.error('ConnectionPool: connection error', { id: conn.id, server: entry.key, err: err.message });
    this._handleClose(entry, conn);
  }

  private _startIdleTimer(entry: ServerEntry, conn: InternalConnection): void {
    if (conn.idleTimer) clearTimeout(conn.idleTimer);

    conn.idleTimer = setTimeout(() => {
      const currentCount = entry.connections.size;
      if (!conn.busy && currentCount > this.opts.minConnectionsPerServer) {
        logger.debug('ConnectionPool: closing idle connection', { id: conn.id, server: entry.key });
        this._closeInternal(conn);
        entry.connections.delete(conn.id);
      }
    }, this.opts.idleTimeoutMs);

    // Do not block Node.js exit for idle timers
    if (conn.idleTimer.unref) conn.idleTimer.unref();
  }

  private _closeInternal(conn: InternalConnection): void {
    if (conn.closed) return;
    conn.closed = true;
    conn.writeLine = null;

    for (const [, pending] of conn.pending) {
      pending.reject(new Error(`Connection ${conn.id} closed`));
    }
    conn.pending.clear();

    if (conn.idleTimer) {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = null;
    }

    try {
      conn.close();
    } catch {
      // Ignore close errors
    }
  }

  private _drainWaiters(entry: ServerEntry): void {
    while (entry.waiting.length > 0) {
      const idle = this._findIdle(entry);
      if (!idle) break;
      const waiter = entry.waiting.shift()!;
      clearTimeout(waiter.timer);
      idle.busy = true;
      waiter.resolve(this._toPublic(idle));
    }
  }
}
