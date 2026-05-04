import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  HotPathProfiler,
  getHotPathProfiler,
  shutdownHotPathProfiler,
} from '../../../src/observability/hot-path.js';

describe('HotPathProfiler', () => {
  let profiler: HotPathProfiler;

  beforeEach(() => {
    profiler = new HotPathProfiler({ windowMs: 60_000 });
  });

  it('returns empty array when no calls recorded', () => {
    expect(profiler.getHotPaths()).toEqual([]);
  });

  it('top-K by total latency correct', () => {
    profiler.record('s1', 'slow', 500);
    profiler.record('s1', 'slow', 500);
    profiler.record('s2', 'fast', 10);
    profiler.record('s2', 'fast', 10);

    const paths = profiler.getHotPaths({ topK: 2, sortBy: 'totalLatency' });
    expect(paths[0].tool).toBe('slow');
    expect(paths[0].totalLatencyMs).toBe(1000);
    expect(paths[1].tool).toBe('fast');
  });

  it('top-K by p99 correct', () => {
    // slow has very high p99
    for (let i = 0; i < 10; i++) profiler.record('s1', 'slow', i === 9 ? 9000 : 100);
    // medium has moderate latency
    for (let i = 0; i < 10; i++) profiler.record('s2', 'medium', 200);

    const paths = profiler.getHotPaths({ topK: 2, sortBy: 'p99' });
    expect(paths[0].tool).toBe('slow');
    expect(paths[0].p99LatencyMs).toBeGreaterThan(200);
  });

  it('top-K by callCount correct', () => {
    for (let i = 0; i < 5; i++) profiler.record('s1', 'busy', 10);
    profiler.record('s2', 'rare', 1000);

    const paths = profiler.getHotPaths({ topK: 2, sortBy: 'callCount' });
    expect(paths[0].tool).toBe('busy');
    expect(paths[0].callCount).toBe(5);
  });

  it('meanLatencyMs is correct', () => {
    profiler.record('s', 't', 100);
    profiler.record('s', 't', 200);
    profiler.record('s', 't', 300);

    const paths = profiler.getHotPaths();
    expect(paths[0].meanLatencyMs).toBe(200);
  });

  it('window expiry drops old samples', async () => {
    const shortWindowProfiler = new HotPathProfiler({ windowMs: 50 });
    shortWindowProfiler.record('s', 't', 100);
    shortWindowProfiler.record('s', 't', 100);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 80));

    const paths = shortWindowProfiler.getHotPaths();
    expect(paths).toHaveLength(0);
  });

  it('topK limits results', () => {
    for (let i = 0; i < 10; i++) {
      profiler.record(`s${i}`, `t${i}`, i * 10);
    }
    const paths = profiler.getHotPaths({ topK: 3 });
    expect(paths).toHaveLength(3);
  });

  it('deterministic ordering (same data → same ranking)', () => {
    profiler.record('alpha', 'tool', 100);
    profiler.record('alpha', 'tool', 100);
    profiler.record('beta', 'tool', 100);
    profiler.record('beta', 'tool', 100);

    const a = profiler.getHotPaths();
    const b = profiler.getHotPaths();
    expect(a.map((p) => p.server + p.tool)).toEqual(b.map((p) => p.server + p.tool));
  });

  it('reset clears all data', () => {
    profiler.record('s', 't', 100);
    profiler.reset();
    expect(profiler.getHotPaths()).toHaveLength(0);
  });

  describe('singleton', () => {
    afterEach(() => { shutdownHotPathProfiler(); });
    it('getHotPathProfiler returns same instance', () => {
      const a = getHotPathProfiler();
      const b = getHotPathProfiler();
      expect(a).toBe(b);
    });
    it('shutdownHotPathProfiler clears singleton', () => {
      const a = getHotPathProfiler();
      shutdownHotPathProfiler();
      const b = getHotPathProfiler();
      expect(a).not.toBe(b);
    });
  });
});
