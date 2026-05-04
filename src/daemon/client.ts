/**
 * MCP Conductor Daemon Client.
 *
 * Thin agent-side bridge that connects to a running DaemonServer over a Unix
 * socket or TCP and exposes a `callTool` interface compatible with the direct
 * execution path. Authentication uses HMAC-SHA256 with the shared secret read
 * from `~/.mcp-conductor/daemon-auth.json`.
 *
 * The sandbox `mcp.shared.*` API is built on top of this client.
 *
 * @module daemon/client
 */

import { createConnection, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHmac } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { KVSetOptions } from './shared-kv.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthFile {
  sharedSecret: string;
}

interface RpcRequest {
  id: string;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

const DEFAULT_SOCKET_PATH = join(homedir(), '.mcp-conductor', 'daemon.sock');
const DEFAULT_AUTH_PATH = join(homedir(), '.mcp-conductor', 'daemon-auth.json');

// ---------------------------------------------------------------------------
// DaemonClient
// ---------------------------------------------------------------------------

export interface DaemonClientOptions {
  /** Unix socket path. Defaults to `~/.mcp-conductor/daemon.sock`. */
  socketPath?: string;
  /**
   * TCP address of the daemon when connecting over Tailscale.
   * Format: `"host:port"` e.g. `"100.64.0.1:9876"`.
   */
  tailscaleAddress?: string;
  /** Auth configuration. */
  auth?: {
    sharedSecretPath?: string;
    sharedSecret?: string;
  };
  /** Connection timeout in ms. Defaults to 5 000. */
  connectTimeoutMs?: number;
}

/**
 * Client-side bridge to the daemon.
 *
 * Usage:
 * ```typescript
 * const client = new DaemonClient();
 * await client.connect();
 * const result = await client.callTool('list_tools', {});
 * await client.disconnect();
 * ```
 */
export class DaemonClient {
  private readonly socketPath: string;
  private readonly tailscaleAddress?: string;
  private readonly sharedSecret: string;
  private readonly connectTimeoutMs: number;

  private socket: Socket | null = null;
  private connected = false;
  private readonly pending = new Map<string, PendingCall>();
  private buffer = '';
  private nextId = 1;

  constructor(options: DaemonClientOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
    this.tailscaleAddress = options.tailscaleAddress;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;

    const authPath = options.auth?.sharedSecretPath ?? DEFAULT_AUTH_PATH;
    if (options.auth?.sharedSecret) {
      this.sharedSecret = options.auth.sharedSecret;
    } else {
      this.sharedSecret = this.loadSecret(authPath);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Connect to the daemon and complete the auth handshake.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    const socket = await this.openSocket();
    this.socket = socket;

    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => {
      this.connected = false;
      this.rejectAllPending(new Error('DaemonClient: connection closed'));
    });
    socket.on('error', (err) => {
      logger.debug('DaemonClient: socket error', { error: String(err) });
      this.rejectAllPending(err);
    });

    // Complete challenge-response auth.
    await this.authenticate();
    this.connected = true;
    logger.debug('DaemonClient: connected and authenticated');
  }

  /**
   * Gracefully disconnect.
   */
  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
      await new Promise<void>((resolve) => {
        this.socket!.once('close', resolve);
        setTimeout(resolve, 1000);
      });
    }
    this.socket = null;
    logger.debug('DaemonClient: disconnected');
  }

  // ---------------------------------------------------------------------------
  // Public RPC surface
  // ---------------------------------------------------------------------------

  /**
   * Call an MCP tool via the daemon.
   */
  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.rpc('tool.call', { name, args });
  }

  /**
   * Ping the daemon. Useful for health-checks.
   */
  async ping(): Promise<void> {
    await this.rpc('ping', {});
  }

  /** Retrieve daemon statistics. */
  async stats(): Promise<unknown> {
    return this.rpc('stats', {});
  }

  // ---------------------------------------------------------------------------
  // Shared KV API
  // ---------------------------------------------------------------------------

  async kvGet<T>(key: string): Promise<T | null> {
    return this.rpc('kv.get', { key }) as Promise<T | null>;
  }

  async kvSet<T>(key: string, value: T, options?: KVSetOptions): Promise<void> {
    await this.rpc('kv.set', { key, value, options });
  }

  async kvDelete(key: string): Promise<void> {
    await this.rpc('kv.delete', { key });
  }

  async kvList(prefix?: string): Promise<string[]> {
    return this.rpc('kv.list', { prefix }) as Promise<string[]>;
  }

  // ---------------------------------------------------------------------------
  // Shared lock API
  // ---------------------------------------------------------------------------

  async lockAcquire(key: string, options?: { timeoutMs?: number }): Promise<{ release: () => Promise<void> }> {
    await this.rpc('lock.acquire', { key, timeoutMs: options?.timeoutMs });
    return {
      release: async () => {
        await this.rpc('lock.release', { key });
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Pub/sub API
  // ---------------------------------------------------------------------------

  async broadcast(channel: string, message: unknown): Promise<void> {
    await this.rpc('broadcast', { channel, message });
  }

  /**
   * Subscribe to a channel. The handler is invoked for each push event
   * received from the daemon.  Returns an object with `unsubscribe()`.
   */
  subscribe(channel: string, handler: (msg: unknown) => void): { unsubscribe: () => void } {
    const listener = (msg: unknown) => {
      const push = msg as { channel?: string; message?: unknown };
      if (push.channel === channel) {
        handler(push.message);
      }
    };
    this.pushListeners.add(listener);
    // Best-effort fire-and-forget notification to the server.
    this.rpc('subscribe', { channel }).catch(() => {});
    return {
      unsubscribe: () => {
        this.pushListeners.delete(listener);
      },
    };
  }

  private readonly pushListeners = new Set<(msg: unknown) => void>();

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private loadSecret(authPath: string): string {
    // MED-1: open directly instead of existsSync + readFileSync to eliminate
    // the TOCTOU window. ENOENT → user-friendly "start the daemon" message;
    // any other error (EACCES, EIO, etc.) propagates as-is.
    try {
      const raw = readFileSync(authPath, 'utf-8');
      return (JSON.parse(raw) as AuthFile).sharedSecret;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `DaemonClient: auth file not found at ${authPath}. ` +
          'Start the daemon first with `mcp-conductor-cli daemon start`.',
        );
      }
      throw err;
    }
  }

  private openSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      let socket: Socket;

      const timer = setTimeout(() => {
        socket?.destroy();
        reject(new Error(`DaemonClient: connection timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      if (this.tailscaleAddress) {
        const [host, portStr] = this.tailscaleAddress.split(':');
        const port = parseInt(portStr ?? '9876', 10);
        socket = createConnection({ host, port });
      } else {
        socket = createConnection({ path: this.socketPath });
      }

      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async authenticate(): Promise<void> {
    // Wait for the challenge from the server.
    const challenge = await this.waitForMessage('__auth_challenge__');
    const nonce = (challenge as { nonce: string }).nonce;

    // Compute HMAC token and send auth response.
    const token = createHmac('sha256', this.sharedSecret).update(nonce).digest('hex');
    await this.rpc('__auth__', { token });
  }

  private waitForMessage(id: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private rpc(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('DaemonClient: not connected'));
        return;
      }

      const id = String(this.nextId++);
      this.pending.set(id, { resolve, reject });

      const msg: RpcRequest = { id, method, params };
      try {
        this.socket.write(JSON.stringify(msg) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as Record<string, unknown>;
        // HIGH-3: broadcast envelope is structurally distinct from RPC responses.
        // Route it directly to push listeners; never touch the pending RPC map.
        if (raw['__broadcast__'] === true) {
          this.deliverBroadcast(raw['channel'] as string, raw['message']);
          continue;
        }
        this.handleResponse(raw as unknown as RpcResponse);
      } catch {
        logger.warn('DaemonClient: malformed JSON from server');
      }
    }
  }

  /** Deliver a server-pushed broadcast to all matching subscribers. */
  private deliverBroadcast(channel: string, message: unknown): void {
    for (const listener of this.pushListeners) {
      listener({ channel, message });
    }
  }

  private handleResponse(msg: RpcResponse): void {
    // Legacy push events (id === '__push__') — kept for backward compat but
    // new code uses the __broadcast__ envelope path above.
    if (msg.id === '__push__') {
      for (const listener of this.pushListeners) {
        listener(msg.result);
      }
      return;
    }

    const call = this.pending.get(msg.id);
    if (!call) {
      logger.warn('DaemonClient: received response for unknown id', { id: msg.id });
      return;
    }
    this.pending.delete(msg.id);

    if (msg.error) {
      call.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
    } else {
      call.resolve(msg.result);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      call.reject(err);
    }
  }
}
