// End-to-end plumbing test on MOCK backends (toy keyword scorer + toy hashing "embedding").
// It proves the runner, CSV/JSON writers and report generator work together. The numbers it
// produces are meaningless for TRACE-X and are written to a temp folder, never to results/.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDataset, tierRecords, tokens } from "../src/dataset.mjs";
import { reciprocalRankFusion } from "../src/fusion.mjs";
import { runEvaluation } from "../src/run-evaluation.mjs";
import { writeResults } from "../src/results-io.mjs";
import { buildReport } from "../src/report.mjs";
import { evalConfigSnapshot } from "../config.mjs";

const { dataset, queries, qrels } = loadDataset();
const records = tierRecords(dataset, 500);
const docs = records.map((r, i) => ({ id: i + 1, key: r.key, text: `${r.title} ${r.description} ${r.extracted_text}` }));
const idToKey = new Map(docs.map((d) => [d.id, d.key]));

const kwTokens = docs.map((d) => new Set(tokens(d.text)));
const mockKeyword = (depth) => ({ name: "keyword", async search(q) {
  const qt = tokens(q);
  const scored = docs.map((d, i) => ({ id: d.id, s: qt.filter((t) => kwTokens[i].has(t)).length })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || a.id - b.id);
  return { ids: scored.slice(0, depth).map((x) => x.id) };
} });
const embed = (text) => { const v = new Float64Array(64); const t = text.toLowerCase(); for (let i = 0; i < t.length - 2; i += 1) { let h = 0; for (const c of t.slice(i, i + 3)) h = (h * 31 + c.charCodeAt(0)) % 64; v[h] += 1; } const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const vecs = docs.map((d) => embed(d.text));
const mockVector = (depth) => ({ name: "vector", async search(q) {
  const e = embed(q);
  const scored = vecs.map((v, i) => ({ id: docs[i].id, s: v.reduce((a, x, j) => a + x * e[j], 0) }));
  scored.sort((a, b) => b.s - a.s || a.id - b.id);
  return { ids: scored.slice(0, depth).map((x) => x.id), stages: { embed_ms: 0 } };
} });

test("mock pipeline: runner -> JSON/CSV -> report, flagged as mock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tx-eval-"));
  try {
    const config = { ...evalConfigSnapshot(), latency: { warmupPasses: 1, timedPasses: 2 }, bootstrap: { iterations: 300, seed: 3, alpha: 0.05 } };
    const k = config.k;
    const hybrid = { name: "hybrid", async search(q) {
      const a = await mockKeyword(50).search(q), b = await mockVector(50).search(q);
      return { ids: reciprocalRankFusion([a.ids, b.ids], config.rrf_k).slice(0, k).map((e) => e.id) };
    } };
    const res = await runEvaluation({ methods: [mockKeyword(k), mockVector(k), hybrid], queries, qrels, idToKey, config });
    const payload = { meta: { kind: "mock", mock: true, finished_at: "n/a", size: 500, records: 500, queries: queries.length, answerable_queries: 34, cases: 20, dataset: dataset.meta, config, mysql: {}, embedding_model: "mock" }, ...res };
    const files = writeResults(500, payload, dir);
    for (const f of Object.values(files)) assert.ok(existsSync(f));
    const csv = readFileSync(files.perQuery, "utf8").trim().split("\n");
    assert.equal(csv.length, 1 + 3 * 40);
    const roundTrip = JSON.parse(readFileSync(files.json, "utf8"));
    assert.equal(roundTrip.methods.hybrid.quality.overall.queries, 34);
    assert.equal(roundTrip.methods.keyword.quality.no_answer.queries, 6);

    const { markdown, charts } = buildReport({ 500: roundTrip });
    assert.match(markdown, /MOCK backends/);
    assert.match(markdown, /Ranking quality/);
    assert.ok(Object.keys(charts).includes("quality-500.svg") && charts["quality-500.svg"].startsWith("<svg"));
    for (const m of ["keyword", "vector", "hybrid"]) assert.ok(markdown.includes(`| ${m} |`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("report refuses nothing silently: a live-flagged file carries no mock banner", () => {
  const fake = { meta: { mock: false, config: evalConfigSnapshot(), size: 500, records: 500, queries: 40, answerable_queries: 34, cases: 20, finished_at: "x", dataset: { seed: 1 }, mysql: {} },
    methods: {}, comparisons: {} };
  // an empty methods object cannot be reported on: the generator must fail, not invent numbers
  assert.throws(() => buildReport({ 500: fake }));
});

test("report wording: in-process first call is never called a cold start; cold table only when probes exist", async () => {
  const methods = ["keyword", "vector", "hybrid"].map((name) => ({ name, search: async () => ({ ids: [1, 2] }) }));
  const config = { ...evalConfigSnapshot(), latency: { warmupPasses: 1, timedPasses: 1 }, bootstrap: { iterations: 50, seed: 1, alpha: 0.05 } };
  const res = await runEvaluation({ methods, queries, qrels, idToKey, config });
  const r = { meta: { mock: true, config, size: 500, records: 500, queries: 40, answerable_queries: 34, cases: 40, finished_at: "x", dataset: { seed: 1 }, mysql: {}, embedding_model: "mock" }, ...res };
  const without = buildReport({ 500: r }).markdown;
  assert.match(without, /First call \(in process\)/);
  assert.doesNotMatch(without, /\| Cold: first query/);
  assert.match(without, /Independent fresh-process cold-start measurements were not run/);
  const cold = { 500: { summary: { keyword: { samples: 5, first_sample_ms: 9, min_ms: 3, median_ms: 4, max_ms: 9 }, vector: { samples: 5, first_sample_ms: 900, min_ms: 400, median_ms: 450, max_ms: 900 }, hybrid: { samples: 5, first_sample_ms: 950, min_ms: 420, median_ms: 470, max_ms: 950 } } } };
  const withCold = buildReport({ 500: r }, cold).markdown;
  assert.match(withCold, /Cold start in a fresh process/);
  assert.match(withCold, /\| 500 \| vector \| 5 \| 900\.0 \| 400\.0 \| 450\.0 \| 900\.0 \|/);
});
