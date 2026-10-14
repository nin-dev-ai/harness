import type { TaskSize } from "@harness/core";

export interface CostEstimate {
  /** Predicted 80th-percentile cost, in percent of the window (or minutes for budgets). */
  p80: number;
  mean: number;
  samples: number;
  /** Fewer than MIN_SAMPLES samples: the per-size default is used. */
  cold: boolean;
}

export const MIN_SAMPLES = 3;
const ALPHA = 0.3;
const Z80 = 0.8416;

/**
 * Exponentially weighted mean and spread of measured costs (oldest first).
 * With fewer than 3 samples, the conservative per-size default applies.
 */
export function estimateCost(samplesOldestFirst: readonly number[], size: TaskSize, coldDefaults: Record<TaskSize, number>): CostEstimate {
  const n = samplesOldestFirst.length;
  if (n < MIN_SAMPLES) {
    const d = coldDefaults[size];
    return { p80: d, mean: d, samples: n, cold: true };
  }
  let mean = samplesOldestFirst[0]!;
  let variance = 0;
  for (const x of samplesOldestFirst.slice(1)) {
    const diff = x - mean;
    const incr = ALPHA * diff;
    mean += incr;
    variance = (1 - ALPHA) * (variance + diff * incr);
  }
  const p80 = Math.max(0, mean + Z80 * Math.sqrt(Math.max(0, variance)));
  return { p80: round(p80), mean: round(mean), samples: n, cold: false };
}

const round = (x: number) => Math.round(x * 100) / 100;
