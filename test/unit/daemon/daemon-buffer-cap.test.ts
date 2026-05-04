/**
 * B2: Daemon socket buffer cap tests.
 *
 * Verifies that a client streaming more than 10 MB without a newline
 * delimiter causes the server to destroy the socket, preventing OOM.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { DaemonServer } from '../../../src/daemon/server.js';

const TEST_SECRET = 'b2-buffer-cap-test-secret-xyz';
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // must match server constant

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-b2-test-'));
}

function makeServer(dir: string): DaemonServer {
  return new DaemonServer({
    socketPath: join(dir, 'daemon.sock'),
    auth: { sharedSecret: TEST_SECRET },
    kvOptions: {
      persistDir: join(dir, 'kv'),
      skipLoad: true,
      sweepIntervalMs: 999_999,
    },
  });
}

/**
 * Open a raw socket, complete auth handshake, then stream bulk data
 * without a newline. Returns a promise that resolves when the socket closes.
 */
async function streamWithoutNewline(
  socketPath: string,
  bytesToSend: number,
): Promise<{ closed: boolean; closeReason: string }> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    let buffer = '';
    let authenticated = false;

    socket.setEncoding('utf-8');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const msg = JSON.parse(trimmed) as {
          id: string;
          result?: { nonce?: string; authenticated?: boolean };
          error?: { message: string };
        };

        if (msg.id === '__auth_challenge__' && msg.result?.nonce) {
          // Respond with valid HMAC token
          const nonce = msg.result.nonce;
          const token = createHmac('sha256', TEST_SECRET).update(nonce).digest('hex');
          const authMsg = JSON.stringify({ id: 'auth-1', method: 'auth', params: { token } }) + '\n';
          socket.write(authMsg);
        }

        if (msg.id === 'auth-1' && msg.result?.authenticated === true) {
          authenticated = true;
          // Auth succeeded — now stream bulk data without a newline
          const chunkSize = 64 * 1024; // 64 KB chunks
          let sent = 0;

          const sendChunk = (): void => {
            if (sent >= bytesToSend || socket.destroyed) return;
            const toSend = Math.min(chunkSize, bytesToSend - sent);
            const data = randomBytes(toSend).toString('base64').slice(0, toSend);
            const canContinue = socket.write(data);
            sent += toSend;
            if (sent < bytesToSend) {
              if (canContinue) {
                setImmediate(sendChunk);
              } else {
                socket.once('drain', sendChunk);
              }
            }
          };

          sendChunk();
        }
      }
    });

    socket.on('close', () => {
      // Resolve here for orderly close (no write error racing).
      resolve({ closed: true, closeReason: authenticated ? 'after-auth' : 'before-auth' });
    });

    socket.on('error', (_err) => {
      // EPIPE or similar fires when the server destroys the socket while the
      // client is mid-write. This is the expected path for the buffer-cap test:
      // the server kills the socket after auth, so `authenticated` is true.
      // We do NOT resolve here — let the 'close' event fire afterwards and
      // carry the correct closeReason based on the authenticated flag.
    });

    // Safety net: if socket doesn't close within 30 s, resolve anyway
    setTimeout(() => {
      socket.destroy();
      resolve({ closed: false, closeReason: 'timeout' });
    }, 30_000);
  });
}

// ---------------------------------------------------------------------------
// B2: Buffer cap tests
// ---------------------------------------------------------------------------

describe('B2: daemon socket buffer cap (10 MB)', () => {
  let dir: string;
  let server: DaemonServer;

  beforeEach(async () => {
    dir = makeTempDir();
    server = makeServer(dir);
    await server.start();
  });

  afterEach(async () => {
    await server.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('authenticated client streaming 11 MB without newline has socket destroyed', async () => {
    const socketPath = join(dir, 'daemon.sock');
    const BYTES_TO_SEND = MAX_BUFFER_BYTES + 1024 * 1024; // 11 MB

    const result = await streamWithoutNewline(socketPath, BYTES_TO_SEND);

    expect(result.closed).toBe(true);
    expect(result.closeReason).toBe('after-auth');
  }, 35_000);

  it('authenticated client streaming exactly MAX+1 byte without newline has socket destroyed', async () => {
    const socketPath = join(dir, 'daemon.sock');
    // The check fires when buffer.length > MAX_BUFFER_BYTES, so MAX+1 triggers it.
    const BYTES_TO_SEND = MAX_BUFFER_BYTES + 1;

    const result = await streamWithoutNewline(socketPath, BYTES_TO_SEND);

    expect(result.closed).toBe(true);
    expect(result.closeReason).toBe('after-auth');
  }, 35_000);

  it('normal newline-delimited messages under 10 MB are handled correctly', async () => {
    // Sanity check: the buffer cap must not affect normal operation.
    const { DaemonClient } = await import('../../../src/daemon/client.js');
    const client = new DaemonClient({
      socketPath: join(dir, 'daemon.sock'),
      auth: { sharedSecret: TEST_SECRET },
      connectTimeoutMs: 3000,
    });
    await client.connect();
    // ping() returns void — just assert it resolves without throwing.
    await expect(client.ping()).resolves.not.toThrow();
    await client.disconnect();
  });
});
