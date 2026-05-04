/**
 * Anomaly Detector
 *
 * For each (server, tool), tracks the distribution of result sizes and
 * latencies. Flags any call whose value is more than stdDevThreshold
 * standard deviations from the running mean. Detected anomalies are
 * emitted on the EventEmitter and accessible via getAnomalies().
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/index.js';

export interface AnomalyConfig {
  enabled: boolean;
  /** Z-score threshold above which a sample is flagged (default: 3) */
  stdDevThreshold: number;
  /** Minimum samples before anomaly detection activates */
  minSamplesForDetection: number;
  /** Maximum anomaly records to retain in memory */
  maxAnomalyHistory: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  enabled: true,
  stdDevThreshold: 3,
  minSamplesForDetection: 5,
  maxAnomalyHistory: 500,
};

export interface AnomalyEvent {
  server: string;
  tool: string;
  metric: 'latencyMs' | 'resultSizeBytes';
  value: number;
  mean: number;
  stdDev: number;
  zScore: number;
  timestamp: number;
}

interface RunningStats {
  /** Welford online algorithm accumulators */
  n: number;
  mean: number;
  /** M2 (sum of squared deviations) */
  m2: number;
}

function updateStats(stats: RunningStats, value: number): void {
  stats.n += 1;
  const delta = value - stats.mean;
  stats.mean += delta / stats.n;
  const delta2 = value - stats.mean;
  stats.m2 += delta * delta2;
}

function stdDev(stats: RunningStats): number {
  if (stats.n < 2) return 0;
  return Math.sqrt(stats.m2 / (stats.n - 1));
}

interface BucketStats {
  latency: RunningStats;
  resultSize: RunningStats;
}

function emptyStats(): RunningStats {
  return { n: 0, mean: 0, m2: 0 };
}

export class AnomalyDetector extends EventEmitter {
  private config: AnomalyConfig;
  private stats: Map<string, BucketStats> = new Map();
  private anomalies: AnomalyEvent[] = [];

  constructor(config: Partial<AnomalyConfig> = {}) {
    super();
    this.config = { ...DEFAULT_ANOMALY_CONFIG, ...config };
  }

  private bucketKey(server: string, tool: string): string {
    return `${server}::${tool}`;
  }

  private getOrCreateBucket(server: string, tool: string): BucketStats {
    const key = this.bucketKey(server, tool);
    let bucket = this.stats.get(key);
    if (!bucket) {
      bucket = { latency: emptyStats(), resultSize: emptyStats() };
      this.stats.set(key, bucket);
    }
    return bucket;
  }

  private checkAndRecord(
    server: string,
    tool: string,
    metric: 'latencyMs' | 'resultSizeBytes',
    value: number,
    statsEntry: RunningStats
  ): void {
    const sd = stdDev(statsEntry);
    if (
      statsEntry.n >= this.config.minSamplesForDetection &&
      sd > 0
    ) {
      const zScore = Math.abs((value - statsEntry.mean) / sd);
      if (zScore > this.config.stdDevThreshold) {
        const anomaly: AnomalyEvent = {
          server,
          tool,
          metric,
          value,
          mean: statsEntry.mean,
          stdDev: sd,
          zScore,
          timestamp: Date.now(),
        };

        this.anomalies.push(anomaly);
        if (this.anomalies.length > this.config.maxAnomalyHistory) {
          this.anomalies.shift();
        }

        logger.warn('AnomalyDetector: anomaly detected', {
          server,
          tool,
          metric,
          value,
          mean: statsEntry.mean,
          zScore: zScore.toFixed(2),
        });

        this.emit('anomaly', anomaly);
      }
    }
  }

  /**
   * Record a completed call. Updates running stats and checks for anomalies.
   */
  record(
    server: string,
    tool: string,
    latencyMs: number,
    resultSizeBytes: number
  ): void {
    if (!this.config.enabled) return;

    const bucket = this.getOrCreateBucket(server, tool);

    // Check before updating (so we compare against the existing distribution)
    this.checkAndRecord(server, tool, 'latencyMs', latencyMs, bucket.latency);
    this.checkAndRecord(server, tool, 'resultSizeBytes', resultSizeBytes, bucket.resultSize);

    // Now update the running stats
    updateStats(bucket.latency, latencyMs);
    updateStats(bucket.resultSize, resultSizeBytes);
  }

  /** Return all recorded anomaly events (most recent last). */
  getAnomalies(options: { server?: string; tool?: string; sinceMs?: number } = {}): AnomalyEvent[] {
    const cutoff = options.sinceMs !== undefined ? Date.now() - options.sinceMs : 0;
    return this.anomalies.filter((a) => {
      if (a.timestamp < cutoff) return false;
      if (options.server && a.server !== options.server) return false;
      if (options.tool && a.tool !== options.tool) return false;
      return true;
    });
  }

  /** Return current running stats for diagnostics. */
  getStats(): Array<{
    server: string;
    tool: string;
    latency: { n: number; mean: number; stdDev: number };
    resultSize: { n: number; mean: number; stdDev: number };
  }> {
    return Array.from(this.stats.entries()).map(([key, b]) => {
      const parts = key.split('::');
        const server = parts[0] ?? key;
        const tool = parts[1] ?? '';
      return {
        server,
        tool,
        latency: { n: b.latency.n, mean: b.latency.mean, stdDev: stdDev(b.latency) },
        resultSize: { n: b.resultSize.n, mean: b.resultSize.mean, stdDev: stdDev(b.resultSize) },
      };
    });
  }

  reset(): void {
    this.stats.clear();
    this.anomalies = [];
  }
}

// Module-level singleton

let _instance: AnomalyDetector | null = null;

export function getAnomalyDetector(config?: Partial<AnomalyConfig>): AnomalyDetector {
  if (!_instance) {
    _instance = new AnomalyDetector(config);
  }
  return _instance;
}

export function shutdownAnomalyDetector(): void {
  _instance = null;
}
