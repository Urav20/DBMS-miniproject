// Descriptive statistics and a seeded paired bootstrap.
import { makeRng } from "./rng.mjs";

export const defined = (xs) => xs.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
export const mean = (xs) => {
  const v = defined(xs);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// Linear interpolation between closest ranks (the "type 7" definition used by NumPy/Excel).
export function percentile(values, p) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export function summarizeMs(samples) {
  if (!samples.length) return null;
  return {
    samples: samples.length,
    mean: mean(samples),
    median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    min: Math.min(...samples),
    max: Math.max(...samples),
  };
}

// Paired bootstrap over queries. a[i] and b[i] belong to the same query; pairs with a null are
// dropped. Returns the mean of (a - b) with a percentile confidence interval.
export function pairedBootstrap(a, b, { iterations, seed, alpha }) {
  const diffs = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== null && b[i] !== null && Number.isFinite(a[i]) && Number.isFinite(b[i])) diffs.push(a[i] - b[i]);
  }
  if (!diffs.length) return null;
  const rng = makeRng(seed);
  const means = new Array(iterations);
  for (let it = 0; it < iterations; it += 1) {
    let s = 0;
    for (let j = 0; j < diffs.length; j += 1) s += diffs[rng.int(diffs.length)];
    means[it] = s / diffs.length;
  }
  return {
    pairs: diffs.length,
    mean_diff: mean(diffs),
    ci_low: percentile(means, alpha / 2),
    ci_high: percentile(means, 1 - alpha / 2),
    share_resamples_above_zero: means.filter((m) => m > 0).length / iterations,
  };
}
