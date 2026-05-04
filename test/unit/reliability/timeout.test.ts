import { describe, expect, test, vi } from 'vitest';
import { withTimeout, withTimeoutSimple } from '../../../src/reliability/timeout.js';
import { TimeoutError } from '../../../src/reliability/errors.js';

const SERVER = 'srv';
const TOOL = 'tool';

describe('withTimeout', () => {
  test('does not affect successful fast calls', async () => {
    const fn = vi.fn(async (_signal: AbortSignal) => 'fast-result');
    const result = await withTimeout(fn, { timeoutMs: 1000, server: SERVER, tool: TOOL });
    expect(result).toBe('fast-result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('rejects after timeoutMs', async () => {
    const fn = async (_signal: AbortSignal) =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('never')), 500));

    await expect(
      withTimeout(fn, { timeoutMs: 30, server: SERVER, tool: TOOL })
    ).rejects.toThrow(TimeoutError);
  }, 2000);

  test('TimeoutError carries server, tool, timeoutMs, attempt', async () => {
    const fn = async (_signal: AbortSignal) =>
      new Promise<never>(() => {}); // hangs forever

    const err = await withTimeout(fn, {
      timeoutMs: 30, server: SERVER, tool: TOOL, attempt: 2,
    }).catch(e => e);

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).server).toBe(SERVER);
    expect((err as TimeoutError).tool).toBe(TOOL);
    expect((err as TimeoutError).timeoutMs).toBe(30);
    expect((err as TimeoutError).attempts).toBe(2);
  }, 2000);

  test('aborts underlying call when AbortSignal supported', async () => {
    let signalAborted = false;
    const fn = async (signal: AbortSignal) => {
      return new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          signalAborted = true;
          reject(new Error('aborted'));
        });
      });
    };

    await withTimeout(fn, { timeoutMs: 30, server: SERVER, tool: TOOL }).catch(() => {});
    expect(signalAborted).toBe(true);
  }, 2000);

  test('propagates non-timeout errors without wrapping', async () => {
    const fn = async (_signal: AbortSignal) => {
      throw new Error('business-error');
    };
    await expect(
      withTimeout(fn, { timeoutMs: 1000, server: SERVER, tool: TOOL })
    ).rejects.toThrow('business-error');
  });
});

describe('withTimeoutSimple', () => {
  test('wraps zero-arg function', async () => {
    const fn = vi.fn(async () => 42);
    const result = await withTimeoutSimple(fn, { timeoutMs: 1000, server: SERVER, tool: TOOL });
    expect(result).toBe(42);
  });
});
