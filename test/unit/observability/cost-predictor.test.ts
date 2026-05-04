import { describe, it, expect, beforeEach } from 'vitest';
import {
  CostPredictor,
  argsShapeFingerprint,
  getCostPredictor,
  shutdownCostPredictor,
} from '../../../src/observability/cost-predictor.js';

describe('argsShapeFingerprint', () => {
  it('produces identical fingerprint for same-shape args with different values', () => {
    const a = argsShapeFingerprint({ path: '/foo', limit: 10 });
    const b = argsShapeFingerprint({ path: '/bar', limit: 99 });
    expect(a).toBe(b);
  });

  it('produces different fingerprint for different shapes', () => {
    const a = argsShapeFingerprint({ path: '/foo' });
    const b = argsShapeFingerprint({ path: '/foo', extra: true });
    expect(a).not.toBe(b);
  });

  it('is stable across calls (deterministic)', () => {
    const args = { x: 1, z: 'hello', a: [1, 2] };
    expect(argsShapeFingerprint(args)).toBe(argsShapeFingerprint(args));
  });

  it('sorts keys for stability', () => {
    const a = argsShapeFingerprint({ z: 1, a: 'x' });
    const b = argsShapeFingerprint({ a: 'y', z: 2 });
    expect(a).toBe(b);
  });

  it('handles null values', () => {
    const fp = argsShapeFingerprint({ x: null });
    expect(fp).toContain('null');
  });

  it('handles nested objects', () => {
    const a = argsShapeFingerprint({ opts: { deep: 'hello' } });
    const b = argsShapeFingerprint({ opts: { deep: 'world' } });
    expect(a).toBe(b);
  });
});

describe('CostPredictor', () => {
  let predictor: CostPredictor;

  beforeEach(() => {
    predictor = new CostPredictor({ minSamplesForPrediction: 3 });
  });

  it('returns null prediction below minSamples', () => {
    predictor.record('srv', 'tool', { path: '/a' }, { outputText: 'result', latencyMs: 100 });
    predictor.record('srv', 'tool', { path: '/b' }, { outputText: 'result', latencyMs: 110 });
    const pred = predictor.predict('srv', 'tool', { path: '/c' });
    expect(pred).toBeNull();
  });

  it('returns a prediction after minSamples', () => {
    for (let i = 0; i < 5; i++) {
      predictor.record('srv', 'tool', { path: `/p${i}` }, { outputText: 'x'.repeat(400), latencyMs: 200 });
    }
    const pred = predictor.predict('srv', 'tool', { path: '/new' });
    expect(pred).not.toBeNull();
    expect(pred!.basedOn).toBe(5);
    expect(pred!.estimatedOutputTokens).toBeGreaterThan(0);
    expect(pred!.estimatedLatencyMs).toBe(200);
  });

  it('prediction within 30% of actual on benchmark (after 10+ samples)', () => {
    const actualOutputTokens = 100; // ~400 chars / 4
    const actualLatency = 150;
    for (let i = 0; i < 15; i++) {
      predictor.record(
        'srv', 'bench',
        { query: `q${i}` },
        { outputText: 'x'.repeat(400), latencyMs: actualLatency }
      );
    }
    const pred = predictor.predict('srv', 'bench', { query: 'new' });
    expect(pred).not.toBeNull();
    expect(pred!.basedOn).toBeGreaterThanOrEqual(10);
    // Within 30%
    expect(pred!.estimatedOutputTokens).toBeGreaterThanOrEqual(actualOutputTokens * 0.7);
    expect(pred!.estimatedOutputTokens).toBeLessThanOrEqual(actualOutputTokens * 1.3);
    expect(pred!.estimatedLatencyMs).toBeGreaterThanOrEqual(actualLatency * 0.7);
    expect(pred!.estimatedLatencyMs).toBeLessThanOrEqual(actualLatency * 1.3);
  });

  it('predictFromCode returns null below minSamples', () => {
    expect(predictor.predictFromCode('const x = 1;')).toBeNull();
  });

  it('predictFromCode aggregates all buckets', () => {
    for (let i = 0; i < 5; i++) {
      predictor.record('s1', 'ta', { k: i }, { outputText: 'abc'.repeat(10), latencyMs: 100 });
    }
    const pred = predictor.predictFromCode('const x = 1;');
    expect(pred).not.toBeNull();
    expect(pred!.estimatedInputTokens).toBeGreaterThan(0);
  });

  it('trims bucket to maxSamplesPerBucket', () => {
    const p = new CostPredictor({ maxSamplesPerBucket: 5, minSamplesForPrediction: 3 });
    for (let i = 0; i < 20; i++) {
      p.record('s', 't', { k: i }, { outputText: 'x', latencyMs: i });
    }
    const stats = p.getBucketStats();
    expect(Object.values(stats)[0]).toBe(5);
  });

  it('reset clears all buckets', () => {
    predictor.record('s', 't', { k: 1 }, { outputText: 'x', latencyMs: 10 });
    predictor.reset();
    expect(Object.keys(predictor.getBucketStats()).length).toBe(0);
  });

  describe('singleton', () => {
    afterEach(() => { shutdownCostPredictor(); });
    it('getCostPredictor returns same instance', () => {
      const a = getCostPredictor();
      const b = getCostPredictor();
      expect(a).toBe(b);
    });
    it('shutdownCostPredictor clears the singleton', () => {
      const a = getCostPredictor();
      shutdownCostPredictor();
      const b = getCostPredictor();
      expect(a).not.toBe(b);
    });
  });
});
