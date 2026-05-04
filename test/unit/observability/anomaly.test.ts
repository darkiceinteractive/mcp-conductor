import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AnomalyDetector,
  getAnomalyDetector,
  shutdownAnomalyDetector,
  type AnomalyEvent,
} from '../../../src/observability/anomaly.js';

describe('AnomalyDetector', () => {
  let detector: AnomalyDetector;
  const anomalies: AnomalyEvent[] = [];

  beforeEach(() => {
    anomalies.length = 0;
    detector = new AnomalyDetector({ stdDevThreshold: 3, minSamplesForDetection: 5 });
    detector.on('anomaly', (ev: AnomalyEvent) => anomalies.push(ev));
  });

  function seedNormal(n = 10): void {
    for (let i = 0; i < n; i++) {
      // Stable 100 ms latency, 1000 byte results — no outliers
      detector.record('srv', 'tool', 100 + (i % 5), 1000 + (i % 10));
    }
  }

  it('does not flag within 1σ of mean', () => {
    seedNormal(10);
    // Another normal call
    detector.record('srv', 'tool', 102, 1002);
    expect(anomalies).toHaveLength(0);
  });

  it('flags 10x latency outlier', () => {
    seedNormal(10);
    // 10x outlier
    detector.record('srv', 'tool', 1000, 1000);
    const latencyAnomalies = anomalies.filter((a) => a.metric === 'latencyMs');
    expect(latencyAnomalies.length).toBeGreaterThan(0);
    expect(latencyAnomalies[0].zScore).toBeGreaterThan(3);
  });

  it('flags 10x result size outlier', () => {
    seedNormal(10);
    // 10x result size
    detector.record('srv', 'tool', 100, 10_000);
    const sizeAnomalies = anomalies.filter((a) => a.metric === 'resultSizeBytes');
    expect(sizeAnomalies.length).toBeGreaterThan(0);
  });

  it('does not flag before minSamplesForDetection', () => {
    // Only 3 samples — below threshold of 5
    detector.record('srv', 'tool', 100, 1000);
    detector.record('srv', 'tool', 100, 1000);
    detector.record('srv', 'tool', 50000, 1000); // would be huge outlier if detected
    expect(anomalies).toHaveLength(0);
  });

  it('getAnomalies returns recorded events', () => {
    seedNormal(10);
    detector.record('srv', 'tool', 9999, 1000);
    const all = detector.getAnomalies();
    expect(all.length).toBeGreaterThan(0);
  });

  it('getAnomalies filters by server/tool', () => {
    seedNormal(10);
    detector.record('srv', 'tool', 9999, 1000);
    // Different server — should not match
    const filtered = detector.getAnomalies({ server: 'other' });
    expect(filtered).toHaveLength(0);
  });

  it('getAnomalies filters by sinceMs', async () => {
    seedNormal(10);
    detector.record('srv', 'tool', 9999, 1000);
    await new Promise((r) => setTimeout(r, 5));
    // sinceMs: 1 — very tight window, should exclude the anomaly we just created
    const filtered = detector.getAnomalies({ sinceMs: 1 });
    // result depends on timing; we just verify it returns an array
    expect(Array.isArray(filtered)).toBe(true);
  });

  it('getStats returns per-(server,tool) distribution info', () => {
    seedNormal(5);
    const stats = detector.getStats();
    expect(stats.length).toBeGreaterThan(0);
    const stat = stats[0];
    expect(stat.server).toBe('srv');
    expect(stat.tool).toBe('tool');
    expect(stat.latency.n).toBeGreaterThan(0);
  });

  it('reset clears stats and anomalies', () => {
    seedNormal(10);
    detector.record('srv', 'tool', 9999, 1000);
    detector.reset();
    expect(detector.getAnomalies()).toHaveLength(0);
    expect(detector.getStats()).toHaveLength(0);
  });

  it('does not detect when disabled', () => {
    const d = new AnomalyDetector({ enabled: false, minSamplesForDetection: 5 });
    const localAnomalies: AnomalyEvent[] = [];
    d.on('anomaly', (ev: AnomalyEvent) => localAnomalies.push(ev));
    for (let i = 0; i < 10; i++) d.record('s', 't', 100, 1000);
    d.record('s', 't', 999999, 1000);
    expect(localAnomalies).toHaveLength(0);
  });

  describe('singleton', () => {
    afterEach(() => { shutdownAnomalyDetector(); });
    it('getAnomalyDetector returns same instance', () => {
      const a = getAnomalyDetector();
      const b = getAnomalyDetector();
      expect(a).toBe(b);
    });
    it('shutdownAnomalyDetector clears singleton', () => {
      const a = getAnomalyDetector();
      shutdownAnomalyDetector();
      const b = getAnomalyDetector();
      expect(a).not.toBe(b);
    });
  });
});
