import test from "node:test";
import assert from "node:assert/strict";
import { runColdProbes, parseProbeOutput, summarizeCold } from "../src/cold.mjs";

const line = (o) => `noise\nCOLD_PROBE_RESULT ${JSON.stringify(o)}\n`;

test("each sample is a separate spawn, interleaved by method, repeats times", () => {
  const calls = [];
  const spawn = ({ method, size }) => { calls.push(method); return { status: 0, stdout: line({ method, query_id: "Q17", ms: calls.length * 10, results: 10, stages: null, pid: 1000 + calls.length }) }; };
  const out = runColdProbes({ size: 500, repeats: 3, spawn });
  assert.deepEqual(calls, ["keyword", "vector", "hybrid", "keyword", "vector", "hybrid", "keyword", "vector", "hybrid"]);
  assert.equal(out.samples.length, 9);
  assert.equal(new Set(out.samples.map((s) => s.pid)).size, 9); // distinct processes
  assert.deepEqual(out.summary.keyword, { samples: 3, first_sample_ms: 10, min_ms: 10, median_ms: 40, max_ms: 70 });
});

test("a failing probe aborts with the child's message instead of inventing a number", () => {
  const spawn = () => ({ status: 1, stdout: "", stderr: "ERROR: model could not be loaded" });
  assert.throws(() => runColdProbes({ size: 500, repeats: 1, spawn }), /Cold probe failed for keyword.*model could not be loaded/);
});

test("output without a result line is rejected", () => {
  assert.throws(() => parseProbeOutput("just logs"), /no result line/);
  assert.equal(parseProbeOutput(line({ ms: 5 })).ms, 5);
});

test("summary uses the median of an even number of samples", () => {
  assert.equal(summarizeCold([{ method: "a", ms: 1 }, { method: "a", ms: 3 }]).a.median_ms, 2);
});
