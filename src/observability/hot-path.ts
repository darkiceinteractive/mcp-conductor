/**
 * Hot-Path Profiler
 *
 * Wraps every backend call in a latency tracker and aggregates per (server, tool).
 * Uses a rolling window so old samples expire automatically. Surfaces top-K
 * paths by total time or by p99 latency.
 */

import { logger } from '../utils/index.js';

export interface HotPathConfig {
  enabled: boolean;
  /** Rolling window in milliseconds (default: 1 hour) */
  windowMs: number;
  /** Maximum samples to retain per (server, tool) bucket */
  maxSamplesPerBucket: number;
}

export const DEFAULT_HOT_PATH_CONFIG: HotPathConfig = {
  enabled: true,
  windowMs: 3_600_000,
  maxSamplesPerBucket: 1_000,
};

interface LatencySample {
  latencyMs: number;
  timestamp: number;
}

interface PathBucket {
  server: string;
  tool: string;
  samples: LatencySample[];
}

export interface HotPathEntry {
  server: string;
  tool: string;
  callCount: number;
  totalLatencyMs: number;
  meanLatencyMs: number;
  p99LatencyMs: number;
}

function p99(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * 0.99) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

export class HotPathProfiler {
  private config: HotPathConfig;
  private buckets: Map<string, PathBucket> = new Map();

  constructor(config: Partial<HotPathConfig> = {}) {
    this.config = { ...DEFAULT_HOT_PATH_CONFIG, ...config };
  }

  private bucketKey(server: string, tool: string): string {
    return `${server}::${tool}`;
  }

  /** Record a completed call with its measured latency. */
  record(server: string, tool: string, latencyMs: number): void {
    if (!this.config.enabled) return;

    const key = this.bucketKey(server, tool);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { server, tool, samples: [] };
      this.buckets.set(key, bucket);
    }

    bucket.samples.push({ latencyMs, timestamp: Date.now() });

    // Trim to max window size
    if (bucket.samples.length > this.config.maxSamplesPerBucket) {
      bucket.samples.splice(0, bucket.samples.length - this.config.maxSamplesPerBucket);
    }

    logger.debug('HotPathProfiler: recorded', { server, tool, latencyMs });
  }

  /** Evict samples older than windowMs from all buckets. */
  private evictExpired(): void {
    const cutoff = Date.now() - this.config.windowMs;
    for (const [key, bucket] of this.buckets.entries()) {
      bucket.samples = bucket.samples.filter((s) => s.timestamp >= cutoff);
      if (bucket.samples.length === 0) {
        this.buckets.delete(key);
      }
    }
  }

  private computeEntry(bucket: PathBucket, liveSamples: LatencySample[]): HotPathEntry {
    const latencies = liveSamples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const total = latencies.reduce((s, v) => s + v, 0);
    const n = latencies.length;
    return {
      server: bucket.server,
      tool: bucket.tool,
      callCount: n,
      totalLatencyMs: total,
      meanLatencyMs: n > 0 ? Math.round(total / n) : 0,
      p99LatencyMs: p99(latencies),
    };
  }

  /**
   * Return top-K paths. sortBy controls ranking:
   *   'totalLatency' — highest cumulative cost first (default)
   *   'p99'          — highest tail latency first
   *   'callCount'    — most called first
   */
  getHotPaths(options: {
    sinceMs?: number;
    topK?: number;
    sortBy?: 'totalLatency' | 'p99' | 'callCount';
  } = {}): HotPathEntry[] {
    this.evictExpired();

    const { sinceMs, topK = 10, sortBy = 'totalLatency' } = options;
    const cutoff = sinceMs !== undefined ? Date.now() - sinceMs : 0;

    const entries: HotPathEntry[] = [];
    for (const bucket of this.buckets.values()) {
      const live = sinceMs !== undefined
        ? bucket.samples.filter((s) => s.timestamp >= cutoff)
        : bucket.samples;
      if (live.length === 0) continue;
      entries.push(this.computeEntry(bucket, live));
    }

    // Deterministic sort: primary key, then server+tool as tiebreaker
    entries.sort((a, b) => {
      let diff = 0;
      switch (sortBy) {
        case 'p99':        diff = b.p99LatencyMs - a.p99LatencyMs; break;
        case 'callCount':  diff = b.callCount - a.callCount; break;
        default:           diff = b.totalLatencyMs - a.totalLatencyMs;
      }
      if (diff !== 0) return diff;
      // Tiebreak by server then tool for stable ordering
      const sk = a.server.localeCompare(b.server);
      if (sk !== 0) return sk;
      return a.tool.localeCompare(b.tool);
    });

    return entries.slice(0, topK);
  }

  reset(): void {
    this.buckets.clear();
  }
}

// Module-level singleton

let _instance: HotPathProfiler | null = null;

export function getHotPathProfiler(config?: Partial<HotPathConfig>): HotPathProfiler {
  if (!_instance) {
    _instance = new HotPathProfiler(config);
  }
  return _instance;
}

export function shutdownHotPathProfiler(): void {
  _instance = null;
}
