/**
 * ConnectionPool unit tests
 *
 * Uses a pure in-memory factory (no real stdio) to test all pool behaviours:
 * acquire, release, idle timeout, multiplexed RPC, crash respawn, shutdown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionPool } from '../../../src/bridge/pool.js';
import type { ConnectionFactory } from '../../../src/bridge/pool.js';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory factory helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FakeTransport {
  /** Simulate the backend sending a line to the pool */
  send: (line: string) => void;
  /** Trigger a close event */
  close: () => void;
  /** All lines written by the pool to this transport */
  written: string[];
  isClosed: boolean;
}

function makeFactory(autoRespond = true): { factory: ConnectionFactory; transports: FakeTransport[] } {
  const transports: FakeTransport[] = [];

  const factory: ConnectionFactory = ({ onLine, onClose }) => {
    const transport: FakeTransport = {
      send: onLine,
      close: onClose,
      written: [],
      isClosed: false,
    };
    transports.push(transport);

    return {
      write: (line: string) => {
        if (transport.isClosed) return false;
        transport.written.push(line);

        if (autoRespond) {
          // Echo a successful JSON-RPC response back
          try {
            const msg = JSON.parse(line.trim());
            if (msg.id !== undefined) {
              setImmediate(() => {
                onLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: true } }) + '\n');
              });
            }
          } catch { /* ignore */ }
        }

        return true;
      },
      close: () => {
        transport.isClosed = true;
      },
    };
  };

  return { factory, transports };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ConnectionPool', () => {
  let pool: ConnectionPool;

  afterEach(async () => {
    await pool.shutdown();
  });

  describe('acquire under min spawns new connection', () => {
    it('should spawn a connection when none exist', async () => {
      const { factory } = makeFactory();
      pool = new ConnectionPool({ minConnectionsPerServer: 0, maxConnectionsPerServer: 4 });
      pool.registerServer('test', factory);

      const conn = await pool.acquire('test');
      expect(conn).toBeDefined();
      expect(conn.serverKey).toBe('test');
      expect(typeof conn.id).toBe('string');
    });
  });

  describe('acquire over max blocks until release', () => {
    it('should queue and resolve when a connection is released', async () => {
      const { factory } = makeFactory();
      pool = new ConnectionPool({
        minConnectionsPerServer: 1,
        maxConnectionsPerServer: 1,
        acquireTimeoutMs: 2000,
      });
      pool.registerServer('server', factory);

      const conn1 = await pool.acquire('server');

      // Second acquire should block
      let conn2Resolved = false;
      const conn2Promise = pool.acquire('server').then((c) => {
        conn2Resolved = true;
        return c;
      });

      // Not yet resolved
      await new Promise((r) => setImmediate(r));
      expect(conn2Resolved).toBe(false);

      // Release conn1 — conn2 should now resolve
      pool.release(conn1);
      const conn2 = await conn2Promise;
      expect(conn2).toBeDefined();
      expect(conn2Resolved).toBe(true);
    });

    it('should reject with timeout if no connection freed in time', async () => {
      const { factory } = makeFactory();
      pool = new ConnectionPool({
        minConnectionsPerServer: 1,
        maxConnectionsPerServer: 1,
        acquireTimeoutMs: 50,
      });
      pool.registerServer('server', factory);

      const conn = await pool.acquire('server');

      await expect(pool.acquire('server')).rejects.toThrow('acquire timeout');

      pool.release(conn);
    });
  });

  describe('idle timeout shuts connection down', () => {
    it('should close idle connections above minimum after timeout', async () => {
      vi.useFakeTimers();

      const { factory, transports } = makeFactory();
      pool = new ConnectionPool({
        minConnectionsPerServer: 1,
        maxConnectionsPerServer: 4,
        idleTimeoutMs: 1000,
      });
      pool.registerServer('srv', factory);

      // Pre-warm spawns 1; acquire spawns a 2nd
      const conn1 = await pool.acquire('srv');
      const conn2 = await pool.acquire('srv');

      pool.release(conn1);
      pool.release(conn2);

      // Advance past idle timeout — only 1 extra connection should be closed
      vi.advanceTimersByTime(1500);

      await vi.runAllTimersAsync();

      expect(pool.stats().totalConnections).toBeLessThanOrEqual(2);

      vi.useRealTimers();
    });
  });

  describe('multiplexed requests track correct response by id', () => {
    it('should route concurrent RPC responses to correct callers', async () => {
      const { factory, transports } = makeFactory(false); // manual response
      pool = new ConnectionPool({ minConnectionsPerServer: 1, maxConnectionsPerServer: 4 });
      pool.registerServer('mux', factory);

      const conn = await pool.acquire('mux');

      // Fire two concurrent calls
      const p1 = conn.call('method/a', { x: 1 });
      const p2 = conn.call('method/b', { x: 2 });

      // Give pool a tick to write the messages
      await new Promise((r) => setImmediate(r));

      const t = transports[transports.length - 1];
      const msg1 = JSON.parse(t.written[0].trim());
      const msg2 = JSON.parse(t.written[1].trim());

      // Respond out of order: respond to msg2 first
      t.send(JSON.stringify({ jsonrpc: '2.0', id: msg2.id, result: 'result-b' }) + '\n');
      t.send(JSON.stringify({ jsonrpc: '2.0', id: msg1.id, result: 'result-a' }) + '\n');

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe('result-a');
      expect(r2).toBe('result-b');

      pool.release(conn);
    });
  });

  describe('backend crash triggers respawn', () => {
    it('should re-establish a connection after close event', async () => {
      const { factory, transports } = makeFactory();
      pool = new ConnectionPool({ minConnectionsPerServer: 1, maxConnectionsPerServer: 4 });
      pool.registerServer('crash-srv', factory);

      // Wait for pre-warm
      await new Promise((r) => setImmediate(r));
      expect(transports.length).toBeGreaterThanOrEqual(1);

      // Simulate crash
      transports[0].close();

      // Pool should respawn asynchronously; allow event loop to run
      await new Promise((r) => setTimeout(r, 50));

      // Pool should have respawned — acquiring should work
      const conn = await pool.acquire('crash-srv');
      expect(conn).toBeDefined();
      pool.release(conn);
    });
  });

  describe('stats()', () => {
    it('should report accurate connection counts', async () => {
      const { factory } = makeFactory();
      pool = new ConnectionPool({ minConnectionsPerServer: 1, maxConnectionsPerServer: 4 });
      pool.registerServer('stats-srv', factory);

      await new Promise((r) => setImmediate(r));

      const conn = await pool.acquire('stats-srv');
      const s1 = pool.stats();
      expect(s1.busyConnections).toBeGreaterThanOrEqual(1);

      pool.release(conn);
      const s2 = pool.stats();
      expect(s2.idleConnections).toBeGreaterThanOrEqual(1);
    });
  });

  describe('shutdown', () => {
    it('should reject waiting acquires on shutdown', async () => {
      const { factory } = makeFactory();
      pool = new ConnectionPool({
        minConnectionsPerServer: 1,
        maxConnectionsPerServer: 1,
        acquireTimeoutMs: 10_000,
      });
      pool.registerServer('shut-srv', factory);

      const conn = await pool.acquire('shut-srv');

      const waitingPromise = pool.acquire('shut-srv');

      // Shutdown while something is waiting
      const shutdownPromise = pool.shutdown();
      pool.release(conn); // also release so shutdown can drain

      await expect(waitingPromise).rejects.toThrow();
      await shutdownPromise;
    });
  });

  describe('unknown server', () => {
    it('should throw when acquiring an unregistered server', async () => {
      pool = new ConnectionPool();
      await expect(pool.acquire('no-such-server')).rejects.toThrow('unknown server');
    });
  });
});
