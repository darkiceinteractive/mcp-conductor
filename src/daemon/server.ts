/**
 * MCP Conductor Daemon Server.
 *
 * Listens on a Unix domain socket (primary) and optionally a TCP port (for
 * Tailscale-mesh clients). Enforces HMAC-SHA256 auth on every connection using
 * the shared secret loaded from `~/.mcp-conductor/daemon-auth.json`.
 *
 * Protocol (newline-delimited JSON):
 *   Client → Server:  { id, method, params }
 *   Server → Client:  { id, result } | { id, error }
 *
 * The daemon owns a SharedKV, SharedLock, and in-process pub/sub bus that all
 * connected clients share.
 *
 * @module daemon/server
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, unlinkSync,
} from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { SharedKV, type KVSetOptions } from './shared-kv.js';
import { SharedLock, type LockHandle } from './shared-lock.js';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface AuthFile {
  sharedSecret: string;
}

const DEFAULT_AUTH_PATH = join(homedir(), '.mcp-conductor', 'daemon-auth.json');
const DEFAULT_SOCKET_PATH = join(homedir(), '.mcp-conductor', 'daemon.sock');
const CONDUCTOR_DIR = join(homedir(), '.mcp-conductor');

// B2: Maximum receive-buffer size per client connection (10 MB).
// A client that streams data without ever sending a newline would grow the
// buffer without bound, causing an OOM. Destroy the socket if exceeded.
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** @internal Exported for testing only. Do not call directly in production code. */
export function loadOrCreateSecret(authPath: string): string {
  // MED-1: open the file directly instead of existsSync + readFileSync to
  // eliminate the TOCTOU window. Treat ENOENT as "not found" and fall through
  // to generation; re-throw anything else (permission denied, I/O error, etc.).
  try {
    const raw = readFileSync(authPath, 'utf-8');
    return (JSON.parse(raw) as AuthFile).sharedSecret;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    // File does not exist — fall through to generate a new secret.
  }
  mkdirSync(dirname(authPath), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  const content: AuthFile = { sharedSecret: secret };
  // Pass mode: 0o600 atomically so the file is never world-readable (CRIT-4).
  writeFileSync(authPath, JSON.stringify(content, null, 2), { mode: 0o600, encoding: 'utf-8' });
  logger.info('DaemonServer: generated new shared secret', { authPath });
  return secret;
}

function hmacToken(secret: string, nonce: string): string {
  return createHmac('sha256', secret).update(nonce).digest('hex');
}

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

interface RpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Pub/sub bus
// ---------------------------------------------------------------------------

type MessageHandler = (message: unknown) => void;

class PubSubBus {
  private readonly emitter = new EventEmitter();

  subscribe(channel: string, handler: MessageHandler): { unsubscribe: () => void } {
    this.emitter.on(channel, handler);
    return { unsubscribe: () => this.emitter.off(channel, handler) };
  }

  broadcast(channel: string, message: unknown): void {
    this.emitter.emit(channel, message);
  }
}

// ---------------------------------------------------------------------------
// Per-client state
// ---------------------------------------------------------------------------

/**
 * State tracked per connected client socket.
 * Lock handles are stored here so the server can release them when the
 * client calls `lock.release` (or disconnects).
 */
interface ClientState {
  socket: Socket;
  lockHandles: Map<string, LockHandle>;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface DaemonStats {
  uptime: number;
  connectedClients: number;
  kvKeys: number;
  activeLocks: boolean;
  requestsHandled: number;
}

// ---------------------------------------------------------------------------
// DaemonServer options
// ---------------------------------------------------------------------------

export interface DaemonServerOptions {
  socketPath?: string;
  tcpPort?: number;
  tailscaleHostname?: string;
  auth?: {
    sharedSecretPath?: string;
    sharedSecret?: string;
  };
  kvOptions?: ConstructorParameters<typeof SharedKV>[0];
}

// ---------------------------------------------------------------------------
// DaemonServer
// ---------------------------------------------------------------------------

export class DaemonServer {
  private readonly socketPath: string;
  private readonly tcpPort?: number;
  private readonly sharedSecret: string;
  private readonly kv: SharedKV;
  private readonly lock: SharedLock;
  private readonly bus = new PubSubBus();

  private unixServer?: NetServer;
  private tcpServer?: NetServer;
  /** Map from socket to per-client state (including lock handles). */
  private readonly clients = new Map<Socket, ClientState>();
  private readonly startTime = Date.now();
  private requestsHandled = 0;
  private running = false;

  constructor(options: DaemonServerOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
    this.tcpPort = options.tcpPort;

    const authPath = options.auth?.sharedSecretPath ?? DEFAULT_AUTH_PATH;

    // B4: Validate that sharedSecretPath resolves within CONDUCTOR_DIR.
    // A caller-controlled path could otherwise cause chmodSync to narrow
    // permissions on an arbitrary file outside the conductor directory.
    if (options.auth?.sharedSecretPath !== undefined) {
      const resolvedDir = resolve(dirname(authPath));
      const conductorDir = resolve(CONDUCTOR_DIR);
      if (!isAbsolute(authPath) || !resolvedDir.startsWith(conductorDir + '/') && resolvedDir !== conductorDir) {
        throw new Error(
          `DaemonServer: sharedSecretPath must resolve within CONDUCTOR_DIR (~/.mcp-conductor). Got: ${authPath}`,
        );
      }
    }

    this.sharedSecret = options.auth?.sharedSecret ?? loadOrCreateSecret(authPath);

    this.kv = new SharedKV(options.kvOptions);
    this.lock = new SharedLock();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) throw new Error('DaemonServer is already running');
    this.running = true;

    mkdirSync(CONDUCTOR_DIR, { recursive: true });

    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    await this.startUnixServer();

    if (this.tcpPort !== undefined) {
      await this.startTcpServer();
    }

    logger.info('DaemonServer: started', {
      socketPath: this.socketPath,
      tcpPort: this.tcpPort,
    });
  }

  async shutdown(): Promise<void> {
    this.running = false;

    const closePromises: Promise<void>[] = [];
    for (const [socket] of this.clients) {
      closePromises.push(new Promise<void>((resolve) => {
        socket.once('close', resolve);
        socket.end();
        setTimeout(() => { socket.destroy(); resolve(); }, 2000);
      }));
    }
    await Promise.all(closePromises);
    this.clients.clear();

    await Promise.all([
      this.closeServer(this.unixServer),
      this.closeServer(this.tcpServer),
    ]);

    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }

    await this.kv.shutdown();
    logger.info('DaemonServer: shutdown complete');
  }

  stats(): DaemonStats {
    return {
      uptime: Date.now() - this.startTime,
      connectedClients: this.clients.size,
      kvKeys: this.kv.size,
      activeLocks: this.lock.hasActiveLocks,
      requestsHandled: this.requestsHandled,
    };
  }

  // ---------------------------------------------------------------------------
  // Server startup helpers
  // ---------------------------------------------------------------------------

  private startUnixServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket));
      this.unixServer = server;

      server.once('error', reject);
      server.listen(this.socketPath, () => {
        try { chmodSync(this.socketPath, 0o600); } catch { /* ignore */ }
        server.removeListener('error', reject);
        server.on('error', (err) => {
          logger.error('DaemonServer Unix socket error', { error: String(err) });
        });
        resolve();
      });
    });
  }

  private startTcpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket));
      this.tcpServer = server;

      server.once('error', reject);
      server.listen(this.tcpPort!, '127.0.0.1', () => {
        server.removeListener('error', reject);
        server.on('error', (err) => {
          logger.error('DaemonServer TCP error', { error: String(err) });
        });
        logger.info('DaemonServer: TCP listening', { port: this.tcpPort });
        resolve();
      });
    });
  }

  private closeServer(server?: NetServer): Promise<void> {
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  // ---------------------------------------------------------------------------
  // Connection handling
  // ---------------------------------------------------------------------------

  private handleConnection(socket: Socket): void {
    const state: ClientState = { socket, lockHandles: new Map() };
    this.clients.set(socket, state);
    logger.debug('DaemonServer: client connected', { clients: this.clients.size });

    let authenticated = false;
    let buffer = '';

    const nonce = randomBytes(16).toString('hex');
    this.sendRaw(socket, { id: '__auth_challenge__', result: { nonce } });

    // CRIT-3: close sockets that never complete auth within 10 s → prevents FD exhaustion.
    const authDeadline = setTimeout(() => {
      if (!authenticated) {
        logger.warn('DaemonServer: auth timeout, destroying socket', { remote: socket.remoteAddress });
        socket.destroy();
      }
    }, 10_000);
    authDeadline.unref();

    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // B2: Destroy the socket if the receive buffer exceeds the cap.
      // This prevents an authenticated client from causing OOM by streaming
      // data without ever sending a newline delimiter.
      if (buffer.length > MAX_BUFFER_BYTES) {
        logger.warn('DaemonServer: client exceeded buffer cap, destroying socket', {
          remote: socket.remoteAddress,
          bufferLength: buffer.length,
        });
        socket.destroy();
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const msg = JSON.parse(trimmed) as RpcRequest;

          if (!authenticated) {
            this.handleAuth(socket, msg, nonce, (ok) => {
              authenticated = ok;
              if (ok) {
                clearTimeout(authDeadline); // CRIT-3: auth succeeded; cancel deadline
              } else {
                socket.destroy();
              }
            });
            return;
          }

          // Handle requests without blocking the data handler.
          this.handleRequest(socket, state, msg).catch((err) => {
            logger.error('DaemonServer: request handler error', { error: String(err) });
          });
        } catch {
          logger.warn('DaemonServer: malformed JSON from client');
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(authDeadline);
      // Release all locks held by this client on disconnect.
      for (const [key, handle] of state.lockHandles) {
        handle.release().catch(() => {});
        logger.debug('DaemonServer: auto-released lock on disconnect', { key });
      }
      state.lockHandles.clear();
      this.clients.delete(socket);
      logger.debug('DaemonServer: client disconnected', { clients: this.clients.size });
    });

    socket.on('error', (err) => {
      logger.debug('DaemonServer: client socket error', { error: String(err) });
      this.clients.delete(socket);
    });
  }

  private handleAuth(
    socket: Socket,
    msg: RpcRequest,
    nonce: string,
    callback: (ok: boolean) => void,
  ): void {
    const params = msg.params as { token?: string } | undefined;
    const token = params?.token;

    if (!token) {
      this.sendRaw(socket, { id: msg.id, error: { code: 401, message: 'Missing auth token' } });
      callback(false);
      return;
    }

    const expected = hmacToken(this.sharedSecret, nonce);
    const expectedBuf = Buffer.from(expected, 'utf-8');
    const providedBuf = Buffer.from(token, 'utf-8');

    const ok =
      expectedBuf.length === providedBuf.length &&
      timingSafeEqual(expectedBuf, providedBuf);

    if (ok) {
      this.sendRaw(socket, { id: msg.id, result: { authenticated: true } });
      callback(true);
    } else {
      this.sendRaw(socket, { id: msg.id, error: { code: 401, message: 'Invalid auth token' } });
      callback(false);
    }
  }

  private async handleRequest(socket: Socket, state: ClientState, msg: RpcRequest): Promise<void> {
    this.requestsHandled++;

    try {
      const result = await this.dispatch(msg.method, msg.params, socket, state);
      this.sendRaw(socket, { id: msg.id, result });
    } catch (err) {
      this.sendRaw(socket, {
        id: msg.id,
        error: { code: 500, message: String(err) },
      });
    }
  }

  private async dispatch(
    method: string,
    params: unknown,
    socket: Socket,
    state: ClientState,
  ): Promise<unknown> {
    const p = params as Record<string, unknown> | undefined;

    switch (method) {
      // KV
      case 'kv.get':
        return this.kv.get(p?.key as string);

      case 'kv.set':
        this.kv.set(p?.key as string, p?.value, p?.options as KVSetOptions | undefined);
        return null;

      case 'kv.delete':
        this.kv.delete(p?.key as string);
        return null;

      case 'kv.list':
        return this.kv.list(p?.prefix as string | undefined);

      // Locks
      case 'lock.acquire': {
        const key = p?.key as string;
        const timeoutMs = p?.timeoutMs as number | undefined;

        // HIGH-2: Reject if this client already holds the lock for this key.
        // Silently overwriting the handle would orphan the old handle and
        // permanently deadlock the key for all clients.
        if (state.lockHandles.has(key)) {
          throw new Error(`ALREADY_HOLDS_LOCK: Already holding lock for key '${key}'`);
        }

        // Acquire the lock — this awaits until the lock is free.
        // Node.js is async; concurrent awaits on different sockets yield to
        // the event loop, so release RPCs from other clients can proceed.
        const handle = await this.lock.acquire(key, { timeoutMs });

        // Persist the handle so lock.release can find and call it.
        state.lockHandles.set(key, handle);

        return { acquired: true, key };
      }

      case 'lock.release': {
        const key = p?.key as string;
        const handle = state.lockHandles.get(key);
        if (handle) {
          state.lockHandles.delete(key);
          await handle.release();
          return { released: true };
        }
        return { released: false, reason: 'no handle found for key' };
      }

      // Pub/sub
      case 'broadcast': {
        const channel = p?.channel as string;
        const message = p?.message;
        this.bus.broadcast(channel, message);
        // HIGH-3: wrap in a dedicated envelope so clients cannot confuse a
        // broadcast with an RPC response (e.g. a malicious {id:42,result:{}}
        // broadcast would not be routed to pending RPC id 42).
        // Note: sender is included so self-subscribing clients receive their
        // own broadcasts (the envelope protection prevents injection regardless).
        const envelope = JSON.stringify({ __broadcast__: true, channel, message }) + '\n';
        for (const [client] of this.clients) {
          if (!client.destroyed) {
            client.write(envelope);
          }
        }
        return null;
      }

      case 'subscribe':
        return { subscribed: true };

      // Meta
      case 'ping':
        return { pong: true };

      case 'stats':
        return this.stats();

      case 'tool.call':
        // Placeholder — actual tool dispatch handled by the MCP server layer.
        throw new Error('tool.call not implemented in daemon v3.0 (agents use direct mode)');

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Wire helpers
  // ---------------------------------------------------------------------------

  private sendRaw(socket: Socket, msg: RpcResponse): void {
    if (!socket.destroyed) {
      try {
        socket.write(JSON.stringify(msg) + '\n');
      } catch (err) {
        logger.debug('DaemonServer: failed to write to client', { error: String(err) });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Expose internals for integration tests
  // ---------------------------------------------------------------------------

  get kvStore(): SharedKV { return this.kv; }
  get lockRegistry(): SharedLock { return this.lock; }
}
