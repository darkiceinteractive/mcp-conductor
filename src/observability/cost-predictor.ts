/**
 * Cost Predictor
 *
 * Maintains rolling history per (tool, args-shape-fingerprint) and predicts
 * token cost and latency for future calls. Args-shape fingerprint is derived
 * from the JSON schema of the args (types only, not values) so structurally
 * equivalent calls are grouped together.
 */

import { logger } from '../utils/index.js';

export interface CostPredictorConfig {
  enabled: boolean;
  minSamplesForPrediction: number;
  maxSamplesPerBucket: number;
}

export const DEFAULT_COST_PREDICTOR_CONFIG: CostPredictorConfig = {
  enabled: true,
  minSamplesForPrediction: 5,
  maxSamplesPerBucket: 200,
};

export interface CostSample {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  timestamp: number;
}

export interface CostPrediction {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedLatencyMs: number;
  basedOn: number;
}

interface Bucket {
  samples: CostSample[];
}

/**
 * Derive a stable string fingerprint from the shape (types) of an args object.
 * Values are replaced with their typeof string so { path: '/foo' } and
 * { path: '/bar' } produce the same fingerprint {"path":"string"}.
 */
export function argsShapeFingerprint(args: Record<string, unknown>): string {
  const shape = buildShape(args);
  return JSON.stringify(shape);
}

function buildShape(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array:empty';
    return `array:${typeof buildShape(value[0])}`;
  }
  if (typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = buildShape(v);
    }
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, obj[k]])
    );
  }
  return typeof value;
}

function bucketKey(server: string, tool: string, fingerprint: string): string {
  return `${server}::${tool}::${fingerprint}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class CostPredictor {
  private config: CostPredictorConfig;
  private buckets: Map<string, Bucket> = new Map();

  constructor(config: Partial<CostPredictorConfig> = {}) {
    this.config = { ...DEFAULT_COST_PREDICTOR_CONFIG, ...config };
  }

  record(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    result: { inputText?: string; outputText: string; latencyMs: number }
  ): void {
    if (!this.config.enabled) return;

    const fingerprint = argsShapeFingerprint(args);
    const key = bucketKey(server, tool, fingerprint);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { samples: [] };
      this.buckets.set(key, bucket);
    }

    const sample: CostSample = {
      inputTokens: estimateTokens(result.inputText ?? JSON.stringify(args)),
      outputTokens: estimateTokens(result.outputText),
      latencyMs: result.latencyMs,
      timestamp: Date.now(),
    };

    bucket.samples.push(sample);

    if (bucket.samples.length > this.config.maxSamplesPerBucket) {
      bucket.samples.splice(0, bucket.samples.length - this.config.maxSamplesPerBucket);
    }

    logger.debug('CostPredictor: recorded sample', {
      server,
      tool,
      fingerprint,
      sampleCount: bucket.samples.length,
    });
  }

  predict(
    server: string,
    tool: string,
    args: Record<string, unknown>
  ): CostPrediction | null {
    if (!this.config.enabled) return null;

    const fingerprint = argsShapeFingerprint(args);
    const key = bucketKey(server, tool, fingerprint);
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.samples.length < this.config.minSamplesForPrediction) {
      return null;
    }

    const n = bucket.samples.length;
    const totalInput = bucket.samples.reduce((s, x) => s + x.inputTokens, 0);
    const totalOutput = bucket.samples.reduce((s, x) => s + x.outputTokens, 0);
    const totalLatency = bucket.samples.reduce((s, x) => s + x.latencyMs, 0);

    return {
      estimatedInputTokens: Math.round(totalInput / n),
      estimatedOutputTokens: Math.round(totalOutput / n),
      estimatedLatencyMs: Math.round(totalLatency / n),
      basedOn: n,
    };
  }

  predictFromCode(code: string): CostPrediction | null {
    if (!this.config.enabled) return null;

    const allSamples: CostSample[] = [];
    for (const bucket of this.buckets.values()) {
      allSamples.push(...bucket.samples);
    }

    if (allSamples.length < this.config.minSamplesForPrediction) {
      return null;
    }

    const inputTokens = estimateTokens(code);
    const n = allSamples.length;
    const avgOutputTokens = Math.round(
      allSamples.reduce((s, x) => s + x.outputTokens, 0) / n
    );
    const avgLatency = Math.round(
      allSamples.reduce((s, x) => s + x.latencyMs, 0) / n
    );

    return {
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: avgOutputTokens,
      estimatedLatencyMs: avgLatency,
      basedOn: n,
    };
  }

  getBucketStats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.buckets.entries()) {
      out[k] = v.samples.length;
    }
    return out;
  }

  reset(): void {
    this.buckets.clear();
  }
}

// Module-level singleton

let _instance: CostPredictor | null = null;

export function getCostPredictor(config?: Partial<CostPredictorConfig>): CostPredictor {
  if (!_instance) {
    _instance = new CostPredictor(config);
  }
  return _instance;
}

export function shutdownCostPredictor(): void {
  _instance = null;
}
