import test from "node:test";
import assert from "node:assert/strict";
import { keywordSql, createKeywordMethod } from "../src/methods/keyword.mjs";
import { instrument, createVectorMethod } from "../src/methods/vector.mjs";
import { createHybridMethod } from "../src/methods/hybrid.mjs";
import { runEvaluation } from "../src/run-evaluation.mjs";
import { evalConfigSnapshot } from "../config.mjs";

test("keyword SQL: parameterised, fulltext, scoped to cases, deterministic order, literal limit", () => {
  const sql = keywordSql(3, 10);
  assert.equal((sql.match(/\?/g) || []).length, 2 + 3);
  assert.match(sql, /MATCH\(e\.title, e\.description, e\.extracted_text\) AGAINST \(\? IN NATURAL LANGUAGE MODE\)/);
  assert.match(sql, /e\.status = 'active'/);
  assert.match(sql, /ORDER BY score DESC, e\.evidence_id ASC LIMIT 10$/);
  assert.throws(() => keywordSql(0, 10));
  assert.throws(() => keywordSql(1, "10; DROP TABLE x"));
});

test("keyword method passes the query twice then the case ids, and maps rows", async () => {
  const calls = [];
  const db = { withSession: async (session, fn) => fn({ query: async (sql, params) => { calls.push({ session, params }); return [{ evidence_id: "7", score: "2.5" }, { evidence_id: 3, score: 1 }]; } }) };
  const m = createKeywordMethod({ db, session: { role: "admin", userId: 9 }, caseIds: [4, 5], depth: 10 });
  const r = await m.search("ransom note");
  assert.deepEqual(calls[0].params, ["ransom note", "ransom note", 4, 5]);
  assert.deepEqual(r.ids, [7, 3]);
  assert.equal(calls[0].session.role, "admin");
});

test("vector method uses the Phase 3 service and splits latency into stages", async () => {
  let clock = 0;
  const now = () => clock;
  const repo = { resolveCaseScope: async () => { clock += 2; return [1]; }, loadAuthoritativeRows: async () => { clock += 3; return {}; } };
  const embedder = { embedQuery: async () => { clock += 10; return [0]; } };
  const store = { search: async () => { clock += 5; return []; } };
  const inst = instrument({ repo, getVector: () => ({ embedder, store }), now });
  const service = {
    async search(session, params) {
      await inst.repo.resolveCaseScope(session, params.caseIds);
      const { embedder: e, store: s } = inst.getVector();
      await e.embedQuery(params.query);
      await s.search({});
      await inst.repo.loadAuthoritativeRows(session, {});
      return { results: [{ record_id: 11, similarity_score: 0.9 }, { record_id: 12, similarity_score: 0.8 }] };
    },
  };
  const validate = (b) => ({ ok: true, value: { query: b.query, caseIds: b.case_ids, limit: b.limit } });
  const m = createVectorMethod({ service, take: inst.take, validate, session: { role: "admin", userId: 1 }, caseIds: [1], limit: 10 });
  const r = await m.search("q");
  assert.deepEqual(r.ids, [11, 12]);
  assert.deepEqual(r.stages, { embed_ms: 10, qdrant_ms: 5, mysql_ms: 5 });
});

test("vector method refuses a query Phase 3 validation rejects", async () => {
  const m = createVectorMethod({ service: {}, take: () => ({}), validate: () => ({ ok: false, errors: ["x"] }), session: {}, caseIds: [1], limit: 10 });
  await assert.rejects(() => m.search(""), /validation rejected/);
});

test("hybrid fuses the two lists and reports per-stage time", async () => {
  let c = 0;
  const now = () => (c += 1);
  const keyword = { search: async () => ({ ids: [1, 2, 3] }) };
  const vector = { search: async () => ({ ids: [3, 4, 1], stages: { embed_ms: 7 } }) };
  const h = createHybridMethod({ keyword, vector, k: 3, rrfK: 60, now });
  const r = await h.search("q");
  assert.deepEqual(r.ids, [1, 3, 2]);
  assert.equal(r.stages.vector_embed_ms, 7);
  assert.ok("keyword_ms" in r.stages && "fuse_ms" in r.stages);
});

const fakeCfg = { ...evalConfigSnapshot(), latency: { warmupPasses: 1, timedPasses: 3 }, bootstrap: { iterations: 200, seed: 1, alpha: 0.05 } };

test("runner: same queries and labels for every method; first-call vs warm separated; metrics correct", async () => {
  const queries = [{ id: "q1", category: "c", text: "a" }, { id: "q2", category: "none", text: "b" }];
  const qrels = { q1: { R1: 2, R2: 2 }, q2: {} };
  const idToKey = new Map([[1, "R1"], [2, "R2"], [3, "R3"]]);
  let clock = 0;
  const calls = { a: 0 };
  const mk = (name, lists, cost) => ({ name, async search(t) { calls[name] = (calls[name] ?? 0) + 1; clock += calls[name] === 1 ? cost * 10 : cost; return { ids: lists[t] }; } });
  const methods = [mk("keyword", { a: [1, 3], b: [] }, 1), mk("vector", { a: [3, 1, 2], b: [3] }, 2), mk("hybrid", { a: [1, 2, 3], b: [3] }, 3)];
  const res = await runEvaluation({ methods, queries, qrels, idToKey, config: fakeCfg, now: () => clock });
  assert.equal(res.methods.keyword.quality.overall.queries, 1);
  assert.equal(res.methods.hybrid.quality.overall.rr, 1);
  assert.equal(res.methods.vector.quality.overall.rr, 0.5);
  assert.equal(res.methods.keyword.quality.no_answer.queries_returning_any_result, 0);
  assert.equal(res.methods.vector.quality.no_answer.queries_returning_any_result, 1);
  assert.equal(res.methods.keyword.latency.first_call_in_process_ms.ms, 10);
  assert.equal(res.methods.keyword.latency.warm.samples, 2 * 3);
  assert.equal(res.methods.keyword.latency.warm.median, 1);
  assert.ok(res.comparisons.hybrid_vs_keyword.ndcg);
  assert.equal(res.methods.hybrid.unstable_rankings_across_passes, 0);
});

test("runner: a record outside the dataset aborts the run (isolation check)", async () => {
  const methods = [{ name: "keyword", search: async () => ({ ids: [99] }) }];
  await assert.rejects(
    runEvaluation({ methods, queries: [{ id: "q", category: "c", text: "a" }], qrels: { q: { R1: 2 } }, idToKey: new Map([[1, "R1"]]), config: fakeCfg }),
    /not part of the evaluation dataset/,
  );
});

test("runner: flags rankings that change between passes", async () => {
  let n = 0;
  const methods = [{ name: "keyword", search: async () => ({ ids: [(n += 1) % 2 ? 1 : 2] }) }];
  const res = await runEvaluation({ methods, queries: [{ id: "q", category: "c", text: "a" }], qrels: { q: { R1: 2 } }, idToKey: new Map([[1, "R1"], [2, "R2"]]), config: fakeCfg });
  assert.ok(res.methods.keyword.unstable_rankings_across_passes > 0);
});
