// Verifies every project API the evaluation uses against the REAL Phase 1-3 modules
// (imports resolve to app/src/lib/*; nothing is mocked except the MySQL pool and the vector search call).
// No services are needed. If a Phase 1-3 signature changes, these tests fail.
import test from "node:test";
import assert from "node:assert/strict";
import { createPoolRegistry } from "../../app/src/lib/db/pools.js";
import { createDb } from "../../app/src/lib/db/client.js";
import * as dbIndex from "../../app/src/lib/db/index.js";
import * as vectorIndex from "../../app/src/lib/vector/index.js";
import * as retrieval from "../../app/src/lib/retrieval/index.js";
import * as indexing from "../../app/src/lib/indexing/index.js";
import { RETRIEVAL_LIMITS } from "../../app/src/lib/retrieval/config.js";
import { applyEvalEnv } from "../src/safety.mjs";
import { populateEvalDatabase } from "../src/loader.mjs";
import { resolveEvalAdmin, buildIdMap } from "../src/eval-env.mjs";
import { instrument, createVectorMethod } from "../src/methods/vector.mjs";
import { createKeywordMethod } from "../src/methods/keyword.mjs";
import { generateDataset, loadQueries, tierRecords } from "../src/dataset.mjs";
import { K, DEPTH, CASES } from "../config.mjs";

const DEV_ENV = {
  DB_HOST: "127.0.0.1", DB_PORT: "3306", DB_NAME: "tracex",
  DB_ADMIN_USER: "a", DB_ADMIN_PASSWORD: "x", DB_INVESTIGATOR_USER: "i", DB_INVESTIGATOR_PASSWORD: "x", DB_WORKER_USER: "w", DB_WORKER_PASSWORD: "x",
  QDRANT_URL: "http://127.0.0.1:6333", QDRANT_COLLECTION: "tracex_records", EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
};

// A fake mysql2 pool: records every statement; `answer(sql, params)` returns the rows to hand back.
function fakePoolFactory(answer) {
  const log = [];
  const created = [];
  const createPool = (options) => {
    created.push(options);
    return {
      options,
      async getConnection() {
        return {
          async execute(sql, params) { log.push({ sql, params }); return [answer(sql, params), []]; },
          release() {}, destroy() {},
        };
      },
      async end() {},
    };
  };
  return { createPool, log, created };
}

test("DB layer: exports and session-handle shape the evaluation relies on", async () => {
  for (const name of ["withSession", "query", "callProcedure", "closeAll"]) assert.equal(typeof dbIndex[name], "function", name);
  const fp = fakePoolFactory((sql) => (/^CALL/.test(sql) ? [[{ evidence_id: 9 }], { affectedRows: 0 }] : [{ one: 1 }]));
  const db = createDb({ registry: createPoolRegistry({ createPool: fp.createPool, env: DEV_ENV }) });
  await db.withSession({ role: "admin", userId: 5 }, async (h) => {
    assert.equal(typeof h.query, "function");
    assert.equal(typeof h.call, "function");
    const r = await h.call("sp_register_evidence", [1, null, 2, "t", "d", "x", "h", 3, "2026-01-15 09:00:00", "m", null, null]);
    assert.deepEqual(r.resultSets, [[{ evidence_id: 9 }]]);
  });
  assert.equal(fp.log[0].sql, "SET @tracex_user_id = ?"); // identity is always the first statement
  assert.deepEqual(fp.log[0].params, [5]);
  assert.match(fp.log[1].sql, /^CALL `sp_register_evidence`\((\?, ){11}\?\)$/); // 12 placeholders
  const viaTop = await db.callProcedure({ role: "admin", userId: 5 }, "sp_create_case", ["a", "b", "c"]);
  assert.ok(Array.isArray(viaTop.resultSets));
});

test("DB name override reaches the MySQL pool: the development name is never used", async () => {
  const env = { ...DEV_ENV };
  applyEvalEnv(500, env);
  const fp = fakePoolFactory(() => [{ db: "tracex_eval_500" }]);
  const db = createDb({ registry: createPoolRegistry({ createPool: fp.createPool, env }) });
  await db.withSession({ role: "admin", userId: 1 }, (h) => h.query("SELECT 1"));
  await db.withSession({ role: "worker", userId: null }, (h) => h.query("SELECT 1"));
  assert.deepEqual(fp.created.map((o) => o.database), ["tracex_eval_500", "tracex_eval_500"]);
  assert.equal(DEV_ENV.DB_NAME, "tracex"); // the source object is untouched
});

test("loader, admin lookup and id map work through the REAL db layer (statement-level fake of MySQL)", async () => {
  const ds = generateDataset();
  const recs = tierRecords(ds, 500);
  let registered = 0, cases = 0;
  const seen = [];
  const answer = (sql, params) => {
    seen.push(sql);
    if (/^SET @tracex_user_id/.test(sql)) return [];
    if (/SELECT DATABASE\(\)/.test(sql)) return [{ db: "tracex_eval_500" }];
    if (/FROM app_user u JOIN `role`/.test(sql)) return [{ user_id: 7, is_active: 1, role_name: "Administrator" }];
    if (/AS n\b/.test(sql)) return [{ n: 0 }];
    if (/FROM evidence_type/.test(sql)) return ["Disk image", "System log", "Email message", "Memory dump", "Network capture", "Document", "Chat export", "Screenshot", "Registry export", "Browser history"].map((name, i) => ({ type_id: i + 1, name }));
    if (/CALL `sp_create_case`/.test(sql)) { cases += 1; return [[{ case_id: cases }], { affectedRows: 0 }]; }
    if (/CALL `sp_register_evidence`/.test(sql)) { registered += 1; assert.equal(params.length, 12); return [[{ evidence_id: registered, evidence_no: "EV" }], { affectedRows: 0 }]; }
    if (/AS ev\b/.test(sql)) return [{ ev: registered }];
    if (/AS jobs\b/.test(sql)) return [{ jobs: registered }];
    if (/SELECT evidence_id, sha256, status FROM evidence/.test(sql)) return recs.map((r, i) => ({ evidence_id: i + 1, sha256: r.sha256, status: "active" }));
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const fp = fakePoolFactory(answer);
  const db = createDb({ registry: createPoolRegistry({ createPool: fp.createPool, env: { ...DEV_ENV, DB_NAME: "tracex_eval_500" } }) });
  const admin = await resolveEvalAdmin({ db });
  assert.deepEqual(admin, { role: "admin", userId: 7 });
  const res = await populateEvalDatabase({ db, session: admin, dataset: ds, size: 500 });
  assert.deepEqual([res.cases, res.evidence, res.pending_index_jobs], [CASES, 500, 500]);
  assert.equal((await buildIdMap({ db, session: admin, dataset: ds, size: 500 })).size, 500);
  assert.ok(seen.every((s) => !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(s)), "all writes go through stored procedures");
});

test("Vector layer: config, store and embedder expose what the evaluation calls", () => {
  const env = { ...DEV_ENV };
  applyEvalEnv(2000, env);
  const config = vectorIndex.loadVectorConfig(env);
  assert.equal(config.collection, "tracex_eval_2000");
  const store = vectorIndex.createVectorStore({ config });
  assert.equal(store.name, "tracex_eval_2000");
  for (const m of ["search", "ensureCollection", "countPoints", "inspectCollection", "upsertPoints"]) assert.equal(typeof store[m], "function", `store.${m}`);
  for (const m of ["collectionExists", "deleteCollection"]) assert.equal(typeof store.client[m], "function", `client.${m}`);
  const embedder = vectorIndex.createEmbedder({ config });
  assert.equal(typeof embedder.embedQuery, "function");
  assert.equal(typeof embedder.embedDocuments, "function");
  assert.equal(config.embedding.model, "BAAI/bge-small-en-v1.5");
  assert.equal(config.embedding.dimensions, 384);
  assert.equal(typeof vectorIndex.getVectorServices, "function");
});

test("Retrieval layer: limits cover the evaluation, the validator accepts every request it sends", () => {
  assert.ok(DEPTH <= RETRIEVAL_LIMITS.maxLimit && K <= RETRIEVAL_LIMITS.maxLimit, "depth must be within the Phase 3 maximum");
  assert.ok(CASES <= RETRIEVAL_LIMITS.maxCaseIds);
  const caseIds = Array.from({ length: CASES }, (_, i) => i + 1);
  for (const q of loadQueries()) {
    for (const limit of [K, DEPTH]) {
      const v = retrieval.validateSearchRequest({ query: q.text, case_ids: caseIds, kind: "evidence", limit });
      assert.equal(v.ok, true, `${q.id} rejected: ${JSON.stringify(v)}`);
      assert.equal(v.value.kind, "evidence");
      assert.equal(v.value.limit, limit);
    }
  }
  assert.equal(retrieval.validateSearchRequest({ query: "x", case_ids: caseIds, kind: "evidence", limit: RETRIEVAL_LIMITS.maxLimit + 1 }).ok, false);
  assert.equal(typeof retrieval.createRetrievalRepository({ db: dbIndex }).resolveCaseScope, "function");
  assert.equal(typeof retrieval.createRetrievalRepository({ db: dbIndex }).loadAuthoritativeRows, "function");
});

test("REAL Phase 3 service + evaluation wrappers: empty scope path and result shape", async () => {
  let clock = 0;
  const repo = { resolveCaseScope: async () => { clock += 4; return []; }, loadAuthoritativeRows: async () => { throw new Error("must not be called"); } };
  const getVector = () => ({ embedder: { embedQuery: async () => { throw new Error("not reached"); } }, store: { search: async () => { throw new Error("not reached"); } } });
  const inst = instrument({ repo, getVector, now: () => clock });
  const service = retrieval.createSearchService({ repo: inst.repo, getVector: inst.getVector, logger: { info() {}, warn() {}, error() {} } });
  const m = createVectorMethod({ service, take: inst.take, validate: retrieval.validateSearchRequest, session: { role: "admin", userId: 1 }, caseIds: [1], limit: 10 });
  const r = await m.search("ransom note");
  assert.deepEqual(r.ids, []);
  assert.equal(r.stages.mysql_ms, 4);
});

test("REAL Phase 3 service: ids come from results[].record_id and scores from similarity_score", async () => {
  const { pointId, buildPayload } = vectorIndex;
  assert.equal(typeof pointId, "function");
  assert.equal(typeof buildPayload, "function");
  // reconcile() output field names are fixed by Phase 3's candidates.js
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../app/src/lib/retrieval/candidates.js", import.meta.url), "utf8"));
  assert.match(src, /record_id: row\.recordId/);
  assert.match(src, /similarity_score: round4\(score\)/);
});

test("Indexing layer: worker factory, session and drain contract", () => {
  assert.deepEqual(indexing.WORKER_SESSION, { role: "worker", userId: null });
  const env = { ...DEV_ENV };
  applyEvalEnv(500, env);
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const w = indexing.createDefaultWorker(env, logger);
  for (const m of ["drain", "runOnce", "start", "stop"]) assert.equal(typeof w.worker[m], "function", `worker.${m}`);
  assert.equal(w.vector.store.name, "tracex_eval_500", "the worker must index into the evaluation collection");
  assert.equal(typeof w.repo, "object");
});

test("Keyword method binds the statement the real MySQL driver expects (query + 2 MATCH params + case ids)", async () => {
  const fp = fakePoolFactory(() => [{ evidence_id: 3, score: 1.5 }]);
  const db = createDb({ registry: createPoolRegistry({ createPool: fp.createPool, env: { ...DEV_ENV, DB_NAME: "tracex_eval_500" } }) });
  const kw = createKeywordMethod({ db, session: { role: "admin", userId: 1 }, caseIds: [1, 2, 3], depth: 10 });
  const r = await kw.search("ransom note");
  assert.deepEqual(r.ids, [3]);
  const sent = fp.log.find((l) => /MATCH/.test(l.sql));
  assert.deepEqual(sent.params, ["ransom note", "ransom note", 1, 2, 3]);
  assert.equal((sent.sql.match(/\?/g) || []).length, sent.params.length);
});
