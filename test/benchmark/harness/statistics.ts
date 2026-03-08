/**
 * Statistics Utilities
 *
 * Statistical analysis functions for benchmark results.
 */

/**
 * Statistical result for a series of measurements
 */
export interface StatisticalResult {
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Arithmetic mean */
  mean: number;
  /** Median (50th percentile) */
  median: number;
  /** Standard deviation */
  stdDev: number;
  /** 95th percentile */
  p95: number;
  /** 99th percentile */
  p99: number;
  /** Coefficient of variation (stdDev / mean) */
  cv: number;
  /** Number of samples */
  count: number;
  /** Sum of all values */
  sum: number;
}

/**
 * Calculate comprehensive statistics for a series of values
 */
export function calculateStatistics(values: number[]): StatisticalResult {
  if (values.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      stdDev: 0,
      p95: 0,
      p99: 0,
      cv: 0,
      count: 0,
      sum: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / count;

  // Calculate standard deviation
  const squaredDiffs = sorted.map((v) => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / count;
  const stdDev = Math.sqrt(avgSquaredDiff);

  return {
    min: sorted[0],
    max: sorted[count - 1],
    mean,
    median: percentile(sorted, 50),
    stdDev,
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    cv: mean !== 0 ? stdDev / mean : 0,
    count,
    sum,
  };
}

/**
 * Calculate a specific percentile from sorted values
 */
export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];

  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedValues[lower];
  }

  const fraction = index - lower;
  return sortedValues[lower] * (1 - fraction) + sortedValues[upper] * fraction;
}

/**
 * Calculate histogram bins for a series of values
 */
export function histogram(
  values: number[],
  binCount: number = 10
): Array<{ min: number; max: number; count: number; percentage: number }> {
  if (values.length === 0) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const binSize = (max - min) / binCount;

  const bins = Array(binCount)
    .fill(null)
    .map((_, i) => ({
      min: min + i * binSize,
      max: min + (i + 1) * binSize,
      count: 0,
      percentage: 0,
    }));

  // Count values in each bin
  for (const value of values) {
    const binIndex = Math.min(Math.floor((value - min) / binSize), binCount - 1);
    bins[binIndex].count++;
  }

  // Calculate percentages
  for (const bin of bins) {
    bin.percentage = (bin.count / values.length) * 100;
  }

  return bins;
}

/**
 * Detect outliers using IQR method
 */
export function detectOutliers(values: number[]): {
  outliers: number[];
  inliers: number[];
  lowerBound: number;
  upperBound: number;
} {
  if (values.length < 4) {
    return {
      outliers: [],
      inliers: [...values],
      lowerBound: Math.min(...values),
      upperBound: Math.max(...values),
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;

  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;

  const outliers: number[] = [];
  const inliers: number[] = [];

  for (const value of values) {
    if (value < lowerBound || value > upperBound) {
      outliers.push(value);
    } else {
      inliers.push(value);
    }
  }

  return { outliers, inliers, lowerBound, upperBound };
}

/**
 * Calculate moving average
 */
export function movingAverage(values: number[], windowSize: number): number[] {
  if (values.length < windowSize) {
    return values;
  }

  const result: number[] = [];
  let windowSum = 0;

  // Initial window
  for (let i = 0; i < windowSize; i++) {
    windowSum += values[i];
  }
  result.push(windowSum / windowSize);

  // Slide window
  for (let i = windowSize; i < values.length; i++) {
    windowSum += values[i] - values[i - windowSize];
    result.push(windowSum / windowSize);
  }

  return result;
}

/**
 * Calculate trend (linear regression slope)
 */
export function calculateTrend(values: number[]): {
  slope: number;
  intercept: number;
  r2: number;
} {
  if (values.length < 2) {
    return { slope: 0, intercept: values[0] || 0, r2: 0 };
  }

  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    const xDiff = i - xMean;
    const yDiff = values[i] - yMean;
    numerator += xDiff * yDiff;
    denominator += xDiff * xDiff;
  }

  const slope = denominator !== 0 ? numerator / denominator : 0;
  const intercept = yMean - slope * xMean;

  // Calculate R-squared
  let ssRes = 0;
  let ssTot = 0;

  for (let i = 0; i < n; i++) {
    const predicted = slope * i + intercept;
    ssRes += Math.pow(values[i] - predicted, 2);
    ssTot += Math.pow(values[i] - yMean, 2);
  }

  const r2 = ssTot !== 0 ? 1 - ssRes / ssTot : 0;

  return { slope, intercept, r2 };
}

/**
 * Compare two sets of measurements for statistical significance
 */
export function compareDistributions(
  a: number[],
  b: number[]
): {
  significantlyDifferent: boolean;
  percentDifference: number;
  effectSize: number;
  description: string;
} {
  const statsA = calculateStatistics(a);
  const statsB = calculateStatistics(b);

  const meanDiff = Math.abs(statsA.mean - statsB.mean);
  const percentDifference = statsA.mean !== 0 ? (meanDiff / statsA.mean) * 100 : 0;

  // Calculate pooled standard deviation for effect size
  const pooledStdDev = Math.sqrt(
    (Math.pow(statsA.stdDev, 2) * (statsA.count - 1) +
      Math.pow(statsB.stdDev, 2) * (statsB.count - 1)) /
      (statsA.count + statsB.count - 2)
  );

  // Cohen's d effect size
  const effectSize = pooledStdDev !== 0 ? meanDiff / pooledStdDev : 0;

  // Consider significant if effect size > 0.5 (medium effect)
  const significantlyDifferent = effectSize > 0.5;

  let description: string;
  if (effectSize < 0.2) {
    description = 'No meaningful difference';
  } else if (effectSize < 0.5) {
    description = 'Small difference';
  } else if (effectSize < 0.8) {
    description = 'Medium difference';
  } else {
    description = 'Large difference';
  }

  return {
    significantlyDifferent,
    percentDifference,
    effectSize,
    description,
  };
}

/**
 * Format statistical result as a summary string
 */
export function formatStatsSummary(stats: StatisticalResult, unit: string = 'ms'): string {
  return [
    `Mean: ${stats.mean.toFixed(2)}${unit}`,
    `Median: ${stats.median.toFixed(2)}${unit}`,
    `P95: ${stats.p95.toFixed(2)}${unit}`,
    `P99: ${stats.p99.toFixed(2)}${unit}`,
    `StdDev: ${stats.stdDev.toFixed(2)}${unit}`,
    `CV: ${(stats.cv * 100).toFixed(1)}%`,
    `Range: [${stats.min.toFixed(2)}, ${stats.max.toFixed(2)}]${unit}`,
    `n=${stats.count}`,
  ].join(' | ');
}

/**
 * Calculate confidence interval
 */
export function confidenceInterval(
  stats: StatisticalResult,
  confidence: number = 0.95
): { lower: number; upper: number } {
  // Z-scores for common confidence levels
  const zScores: Record<number, number> = {
    0.90: 1.645,
    0.95: 1.96,
    0.99: 2.576,
  };

  const z = zScores[confidence] || 1.96;
  const marginOfError = z * (stats.stdDev / Math.sqrt(stats.count));

  return {
    lower: stats.mean - marginOfError,
    upper: stats.mean + marginOfError,
  };
}
