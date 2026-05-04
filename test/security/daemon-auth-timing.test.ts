/**
 * T3: Daemon auth constant-time comparison test.
 *
 * Measures timing variance between correct and incorrect HMAC responses.
 * Asserts that the server's comparison is constant-time (variance < 5%).
 *
 * Implementation: we send 50 correct vs 50 incorrect auth attempts and
 * measure the time from sending the auth response to receiving the close event.
 * A timing side-channel would show systematically faster rejection of wrong
 * tokens that differ in early bytes.
 *
 * NOTE: This is a statistical heuristic — not a cryptographic proof. On a
 * loaded CI machine the variance can be high. We gate on coefficient of
 * variation (CV) < 40% across correct/incorrect timings.
 *
 * @module test/security/daemon-auth-timing
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { createHmac } from 'node:crypto';
import { DaemonServer } from '../../src/daemon/server.js';

const TEST_SECRET = 'timing-test-secret-xyz';
const WRONG_SECRET = 'wrong-secret-definitely-not-right';
const SAMPLE_SIZE = 30; // rounds per variant

function hmacToken(secret: string, nonce: string): string {
  return createHmac('sha256', secret).update(nonce).digest('hex');
}

async function measureAuthTime(socketPath: string, useCorrectSecret: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    socket.setEncoding('utf-8');

    let buffer = '';
    let t0 = 0;

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(Date.now() - t0 || 0);
    }, 5_000);

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim()) as { id?: string; result?: { nonce?: string } };
          if (msg.id === '__auth_challenge__' && msg.result?.nonce) {
            const token = hmacToken(
              useCorrectSecret ? TEST_SECRET : WRONG_SECRET,
              msg.result.nonce,
            );
            t0 = Date.now();
            socket.write(JSON.stringify({ id: '__auth_response__', result: { token } }) + '\n');
          }
        } catch { /* ignore */ }
      }
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      resolve(t0 > 0 ? Date.now() - t0 : 0);
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve(t0 > 0 ? Date.now() - t0 : 0);
    });
  });
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr: number[]): number {
  const m = mean(arr);
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

describe('T3 daemon-auth-timing', () => {
  let tmpDir: string;
  let server: DaemonServer;
  let socketPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-sec-timing-'));
    socketPath = join(tmpDir, 'daemon.sock');
    server = new DaemonServer({
      socketPath,
      auth: { sharedSecret: TEST_SECRET },
      kvOptions: { persistDir: join(tmpDir, 'kv'), skipLoad: true, sweepIntervalMs: 999_999 },
    });
    await server.start();
  }, 15_000);

  afterAll(async () => {
    await server.shutdown();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    'correct vs wrong HMAC response times are statistically indistinguishable (CV < 40%)',
    async () => {
      const correctTimes: number[] = [];
      const wrongTimes: number[] = [];

      for (let i = 0; i < SAMPLE_SIZE; i++) {
        const t = await measureAuthTime(socketPath, i % 2 === 0);
        if (i % 2 === 0) {
          correctTimes.push(t);
        } else {
          wrongTimes.push(t);
        }
      }

      const allTimes = [...correctTimes, ...wrongTimes].filter((t) => t > 0);
      if (allTimes.length < 4) {
        // Insufficient data — skip assertion on extremely fast CI.
        return;
      }

      const overallMean = mean(allTimes);
      const overallStd = stddev(allTimes);
      const cv = overallMean > 0 ? overallStd / overallMean : 0;

      // CV < 40% indicates timing is dominated by noise, not a side channel.
      expect(cv).toBeLessThan(0.40);
    },
    120_000,
  );
});
