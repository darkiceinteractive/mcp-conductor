import { describe, expect, test, vi } from 'vitest';
import { withRetry } from '../../../src/reliability/retry.js';
import { RetryExhaustedError, TimeoutError, CircuitOpenError } from '../../../src/reliability/errors.js';

const SERVER = 'srv';
const TOOL = 'tool';
const noSleep = async (_ms: number) => {};

describe('withRetry', () => {
  test('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, {
      retries: 2, retryDelayMs: 10, retryMaxDelayMs: 100,
      server: SERVER, tool: TOOL, sleep: noSleep,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('does not retry mutations (retries=0)', async () => {
    const fn = vi.fn().mockRejectedValue(new TimeoutError(SERVER, 'item_create', 1000, 1));
    await expect(withRetry(fn, {
      retries: 0, retryDelayMs: 10, retryMaxDelayMs: 100,
      server: SERVER, tool: 'item_create', sleep: noSleep,
    })).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on timeout', async () => {
    const timeoutErr = new TimeoutError(SERVER, TOOL, 1000, 1);
    const fn = vi.fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValue('recovered');
    const result = await withRetry(fn, {
      retries: 2, retryDelayMs: 10, retryMaxDelayMs: 100,
      server: SERVER, tool: TOOL, sleep: noSleep,
    });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('retries on network error', async () => {
    const networkErr = new Error('ECONNRESET network error');
    const fn = vi.fn()
      .mockRejectedValueOnce(networkErr)
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValue('ok');
    const result = await withRetry(fn, {
      retries: 3, retryDelayMs: 10, retryMaxDelayMs: 100,
      server: SERVER, tool: TOOL, sleep: noSleep,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('exponential backoff doubles delay', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => { delays.push(ms); };
    const err = new TimeoutError(SERVER, TOOL, 100, 1);
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');
    await withRetry(fn, {
      retries: 3, retryDelayMs: 50, retryMaxDelayMs: 10_000,
      server: SERVER, tool: TOOL, sleep,
    });
    expect(delays).toEqual([50, 100, 200]);
  });

  test('respects max delay ceiling', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => { delays.push(ms); };
    const err = new TimeoutError(SERVER, TOOL, 100, 1);
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');
    await withRetry(fn, {
      retries: 3, retryDelayMs: 500, retryMaxDelayMs: 600,
      server: SERVER, tool: TOOL, sleep,
    });
    // Second delay would be 1000 but capped at 600
    expect(delays[1]).toBe(600);
    expect(delays[2]).toBe(600);
  });

  test('throws RetryExhaustedError after max attempts', async () => {
    const err = new TimeoutError(SERVER, TOOL, 100, 1);
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, {
      retries: 2, retryDelayMs: 10, retryMaxDelayMs: 100,
      server: SERVER, tool: TOOL, sleep: noSleep,
    })).rejects.toThrow(RetryExhaustedError);
    // 1 initial + 2 retries = 3 total
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('non-retryable errors propagate immediately', async () => {
    const genericErr = new Error('business logic error');
    const fn = vi.fn().mockRejectedValue(genericErr);
    await expect(withRetry(fn, {
      retries: 5, retryDelayMs: 10, retryMaxDelayMs: 100,
      server: SERVER, tool: TOOL, sleep: noSleep,
    })).rejects.toThrow('business logic error');
    // Called only once — no retries on non-retryable
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('CircuitOpenError is not retried', async () => {
    const err = new CircuitOpenError(SERVER, TOOL);
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, {
      retries: 5, retryDelayMs: 10, retryMaxDelayMs: 100,
      server: SERVER, tool: TOOL, sleep: noSleep,
    })).rejects.toThrow(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
