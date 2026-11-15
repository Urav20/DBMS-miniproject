// Independent cold-start measurement: every sample is a brand-new Node process, so each one gets
// a fresh MySQL pool, a fresh Qdrant client and a fresh embedding-model load. Methods are
// interleaved (keyword, vector, hybrid, keyword, ...) so none always benefits from running after another.
// What a script CANNOT reset: the MySQL and Qdrant servers' own caches and the OS file cache. Samples after
// the first therefore start with warm servers; all samples are reported (min / median / max), not just one.
import { median } from "./stats-cold.mjs";

const MARK = "COLD_PROBE_RESULT ";

export function parseProbeOutput(stdout) {
  const line = String(stdout).split(/\r?\n/).reverse().find((l) => l.startsWith(MARK));
  if (!line) throw new Error("The cold probe printed no result line.");
  return JSON.parse(line.slice(MARK.length));
}

// spawn({ method, size }) -> { status, stdout, stderr }   (injected so tests need no processes)
export function runColdProbes({ size, methods = ["keyword", "vector", "hybrid"], repeats, spawn, log = () => {} }) {
  const samples = [];
  for (let r = 1; r <= repeats; r += 1) {
    for (const method of methods) {
      log(`cold probe ${r}/${repeats}: ${method}`);
      const out = spawn({ method, size });
      if (out.status !== 0) {
        const tail = String(out.stderr || out.stdout).trim().split(/\r?\n/).slice(-3).join(" | ");
        throw new Error(`Cold probe failed for ${method} (exit ${out.status}): ${tail}`);
      }
      samples.push({ repeat: r, ...parseProbeOutput(out.stdout) });
    }
  }
  return { samples, summary: summarizeCold(samples) };
}

export function summarizeCold(samples) {
  const by = {};
  for (const s of samples) (by[s.method] ??= []).push(s.ms);
  return Object.fromEntries(Object.entries(by).map(([m, v]) => [m, { samples: v.length, first_sample_ms: v[0], min_ms: Math.min(...v), median_ms: median(v), max_ms: Math.max(...v) }]));
}
