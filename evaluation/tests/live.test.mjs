// LIVE integration tests. They need the real MySQL (evaluation database already built, see README)
// and Qdrant, and are skipped unless EVAL_LIVE=1:
//   node evaluation/scripts/test.mjs --live        (after: sql, load, index for the size)
// They are read-only. EVAL_TEST_SIZE selects 500 (default) or 2000.
import test from "node:test";
import assert from "node:assert/strict";

const live = process.env.EVAL_LIVE === "1";
const size = Number(process.env.EVAL_TEST_SIZE ?? 500);
const skip = live ? false : "set EVAL_LIVE=1 (and have the evaluation environment built) to run live tests";

test("live: the process is pointed at the evaluation database and collection", { skip }, async () => {
  const { createLiveContext } = await import("../src/live.mjs");
  const { assertConnectedToEvalDb } = await import("../src/safety.mjs");
  const { resolveEvalAdmin } = await import("../src/eval-env.mjs");
  const ctx = await createLiveContext(size);
  try {
    const admin = await resolveEvalAdmin({ db: ctx.db });
    assert.equal(await assertConnectedToEvalDb(ctx.db, admin), `tracex_eval_${size}`);
    assert.equal(ctx.vector.store.name, `tracex_eval_${size}`);
  } finally { await ctx.db.closeAll?.(); }
});

test("live: every evaluation record is in MySQL and in Qdrant", { skip }, async () => {
  const { createLiveContext } = await import("../src/live.mjs");
  const { loadDataset } = await import("../src/dataset.mjs");
  const { resolveEvalAdmin, buildIdMap, readEvalCases, assertOnlyEvalCases } = await import("../src/eval-env.mjs");
  const ctx = await createLiveContext(size);
  try {
    const { dataset } = loadDataset();
    const admin = await resolveEvalAdmin({ db: ctx.db });
    assertOnlyEvalCases(await readEvalCases({ db: ctx.db, session: admin, size }), size);
    const map = await buildIdMap({ db: ctx.db, session: admin, dataset, size });
    assert.equal(map.size, size);
    const info = await ctx.vector.store.inspectCollection();
    assert.equal(info.exists, true);
    assert.deepEqual(info.problems, []);
    assert.equal(info.points, size);
  } finally { await ctx.db.closeAll?.(); }
});

test("live: keyword, vector and hybrid all answer a known query with records from the evaluation set", { skip }, async () => {
  const { createLiveContext } = await import("../src/live.mjs");
  const { loadDataset } = await import("../src/dataset.mjs");
  const { resolveEvalAdmin, buildIdMap, readEvalCases } = await import("../src/eval-env.mjs");
  const { createKeywordMethod } = await import("../src/methods/keyword.mjs");
  const { instrument, createVectorMethod } = await import("../src/methods/vector.mjs");
  const { createHybridMethod } = await import("../src/methods/hybrid.mjs");
  const ctx = await createLiveContext(size);
  try {
    const { dataset } = loadDataset();
    const admin = await resolveEvalAdmin({ db: ctx.db });
    const repo = ctx.retrieval.createRetrievalRepository({ db: ctx.db });
    const caseIds = (await readEvalCases({ db: ctx.db, session: admin, size })).map((c) => c.case_id);
    const idToKey = await buildIdMap({ db: ctx.db, session: admin, dataset, size });
    const now = () => performance.now();
    const inst = instrument({ repo, getVector: () => ctx.vector, now });
    const service = ctx.retrieval.createSearchService({ repo: inst.repo, getVector: inst.getVector, logger: { info() {}, warn() {}, error() {} } });
    const kw = createKeywordMethod({ db: ctx.db, session: admin, caseIds, depth: 10 });
    const vec = createVectorMethod({ service, take: inst.take, validate: ctx.retrieval.validateSearchRequest, session: admin, caseIds, limit: 10 });
    const hyb = createHybridMethod({ keyword: kw, vector: vec, k: 10, rrfK: 60, now });
    for (const m of [kw, vec, hyb]) {
      const r = await m.search("ransom note");
      assert.ok(r.ids.length > 0, `${m.name} returned nothing`);
      assert.ok(r.ids.every((id) => idToKey.has(id)), `${m.name} returned a record outside the evaluation dataset`);
    }
  } finally { await ctx.db.closeAll?.(); }
});
