import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupe, precisionAtK, recallAtK, f1, reciprocalRankAtK, averagePrecisionAtK, ndcgAtK, evaluateQuery,
} from "../src/metrics.mjs";
import { reciprocalRankFusion } from "../src/fusion.mjs";
import { mean, percentile, pairedBootstrap } from "../src/stats.mjs";
import { aggregateQuality } from "../src/aggregate.mjs";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("precision divides by K, recall by |R|", () => {
  const rel = new Set(["a", "b", "c", "d"]);
  near(precisionAtK(["a", "x", "b", "y", "z"], rel, 5), 2 / 5);
  near(precisionAtK(["a"], rel, 5), 1 / 5); // short list is not rewarded
  near(recallAtK(["a", "x", "b"], rel, 5), 2 / 4);
  assert.equal(recallAtK(["a"], new Set(), 5), null);
});

test("F1 is the harmonic mean, 0 when both are 0", () => {
  near(f1(0.5, 0.25), 2 * 0.5 * 0.25 / 0.75);
  assert.equal(f1(0, 0), 0);
  assert.equal(f1(null, 0.5), null);
});

test("reciprocal rank honours the cut-off", () => {
  const rel = new Set(["r"]);
  near(reciprocalRankAtK(["x", "y", "r"], rel, 10), 1 / 3);
  assert.equal(reciprocalRankAtK(["x", "y", "r"], rel, 2), 0);
});

test("AP@K hand-computed: hits at ranks 1 and 3, |R| = 3, K = 5", () => {
  // (1/1 + 2/3) / min(3, 5)
  near(averagePrecisionAtK(["a", "x", "b", "y", "z"], new Set(["a", "b", "c"]), 5), (1 + 2 / 3) / 3);
  near(averagePrecisionAtK(["a", "b"], new Set(["a", "b"]), 10), 1); // perfect ranking = 1
  near(averagePrecisionAtK(["a", "b"], new Set(["a", "b", "c", "d"]), 1), 1); // normaliser min(|R|, K)
});

test("NDCG uses graded gain with log2(rank + 1) discount", () => {
  const grades = { a: 2, b: 1 };
  near(ndcgAtK(["a", "b"], grades, 10), 1);
  const dcg = 1 / Math.log2(2) + 2 / Math.log2(3); // ranking b then a
  const idcg = 2 / Math.log2(2) + 1 / Math.log2(3);
  near(ndcgAtK(["b", "a"], grades, 10), dcg / idcg);
  assert.equal(ndcgAtK(["a"], {}, 10), null);
});

test("duplicates cannot inflate any metric", () => {
  assert.deepEqual(dedupe(["a", "a", "b", "a"]), ["a", "b"]);
  const grades = { a: 2, b: 2 };
  const once = evaluateQuery({ ranked: ["a", "b", "x"], grades, k: 10 });
  const dup = evaluateQuery({ ranked: ["a", "a", "a", "b", "b", "x"], grades, k: 10 });
  assert.deepEqual(dup, once);
  assert.equal(dup.strict.p, 2 / 10);
});

test("strict view counts grade 2 only; lenient counts grade >= 1", () => {
  const m = evaluateQuery({ ranked: ["rel1", "a", "b"], grades: { a: 2, b: 2, rel1: 1 }, k: 3 });
  near(m.strict.p, 2 / 3);
  near(m.lenient.p, 3 / 3);
  assert.equal(m.strict.relevant_count, 2);
  assert.equal(m.lenient.relevant_count, 3);
});

test("RRF: ranks only, deterministic ties, per-list duplicates ignored", () => {
  const fused = reciprocalRankFusion([["a", "b", "c"], ["c", "a", "a"]], 60);
  assert.deepEqual(fused.map((e) => e.id), ["a", "c", "b"]);
  near(fused[0].score, 1 / 61 + 1 / 62);
  assert.deepEqual(reciprocalRankFusion([[1, 2], [3, 4]], 60).map((e) => e.id), [1, 3, 2, 4]);
});

test("percentile interpolates; mean skips nulls", () => {
  near(percentile([1, 2, 3, 4], 0.5), 2.5);
  near(percentile([10], 0.95), 10);
  near(mean([1, null, 3]), 2);
});

test("paired bootstrap is seeded and detects a consistent gain", () => {
  const a = Array.from({ length: 30 }, (_, i) => 0.6 + (i % 3) * 0.01);
  const b = Array.from({ length: 30 }, () => 0.5);
  const cfg = { iterations: 2000, seed: 7, alpha: 0.05 };
  const r1 = pairedBootstrap(a, b, cfg);
  assert.deepEqual(pairedBootstrap(a, b, cfg), r1);
  assert.ok(r1.ci_low > 0);
  const same = pairedBootstrap(b, b, cfg);
  assert.equal(same.mean_diff, 0);
});

test("aggregation: macro average over answerable queries; no-answer queries kept apart", () => {
  const row = (id, category, grades, ranked) => ({ query_id: id, category, metrics: evaluateQuery({ ranked, grades, k: 10 }) });
  const agg = aggregateQuality([
    row("q1", "exact", { a: 2 }, ["a"]),
    row("q2", "exact", { b: 2, c: 2 }, ["x"]),
    row("q3", "none", {}, ["x", "y"]),
  ]);
  assert.equal(agg.overall.queries, 2);
  near(agg.overall.rr, 0.5);
  assert.equal(agg.no_answer.queries, 1);
  assert.equal(agg.no_answer.queries_returning_any_result, 1);
});
