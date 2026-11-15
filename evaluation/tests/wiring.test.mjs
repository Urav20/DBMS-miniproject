import test from "node:test";
import assert from "node:assert/strict";
import { populateEvalDatabase } from "../src/loader.mjs";
import { indexEvalCollection } from "../src/indexer.mjs";
import { resolveEvalAdmin, buildIdMap, assertOnlyEvalCases, evalCaseNumber } from "../src/eval-env.mjs";
import { generateDataset, tierRecords } from "../src/dataset.mjs";
import { CASES } from "../config.mjs";
import { EvalSafetyError } from "../src/safety.mjs";

const ds = generateDataset();
const ADMIN = { role: "admin", userId: 5 };

function fakeDb({ dbName = "tracex_eval_500", existing = 0, adminRow = null } = {}) {
  const log = { procs: [], registered: 0, statements: [] };
  const query = async (sql) => {
    log.statements.push(sql);
    if (/DATABASE\(\)/.test(sql)) return [{ db: dbName }];
    if (/AS n\b/.test(sql)) return [{ n: existing }];
    if (/FROM evidence_type/.test(sql)) return ["Disk image", "System log", "Email message", "Memory dump", "Network capture", "Document", "Chat export", "Screenshot", "Registry export", "Browser history"].map((name, i) => ({ type_id: i + 1, name }));
    if (/AS ev\b/.test(sql)) return [{ ev: log.registered }];
    if (/AS jobs\b/.test(sql)) return [{ jobs: log.registered }];
    if (/FROM app_user/.test(sql)) return adminRow ? [adminRow] : [];
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const conn = { query, call: async (name, params) => { log.procs.push({ name, params }); log.registered += 1; return { resultSets: [[{ evidence_id: log.registered }]] }; } };
  return {
    log,
    withSession: async (session, fn) => fn(conn),
    callProcedure: async (session, name, params) => { log.procs.push({ name, params }); return { resultSets: [[{ case_id: log.procs.filter((p) => p.name === "sp_create_case").length }]] }; },
  };
}

test("loader registers every tier record through the stored procedures, as the admin, into the evaluation cases", async () => {
  const db = fakeDb();
  const res = await populateEvalDatabase({ db, session: ADMIN, dataset: ds, size: 500 });
  assert.equal(res.evidence, 500);
  assert.equal(res.cases, CASES);
  const cases = db.log.procs.filter((p) => p.name === "sp_create_case");
  assert.deepEqual(cases.map((c) => c.params[0]), Array.from({ length: CASES }, (_, i) => evalCaseNumber(500, i)));
  const reg = db.log.procs.filter((p) => p.name === "sp_register_evidence");
  assert.equal(reg.length, 500);
  assert.equal(new Set(reg.map((r) => r.params[6])).size, 500); // unique sha256
  assert.ok(reg.every((r) => r.params[1] === null)); // no evidence_source
  assert.ok(db.log.statements.every((s) => !/\b(INSERT|UPDATE|DELETE|DROP)\b/i.test(s)), "the loader issues no direct writes");
});

test("loader refuses a database that is not an evaluation database", async () => {
  await assert.rejects(() => populateEvalDatabase({ db: fakeDb({ dbName: "tracex" }), session: ADMIN, dataset: ds, size: 500 }), EvalSafetyError);
});

test("loader refuses a database that already holds data", async () => {
  await assert.rejects(() => populateEvalDatabase({ db: fakeDb({ existing: 3 }), session: ADMIN, dataset: ds, size: 500 }), /not empty/);
});

test("evaluation admin must exist, be active and be an Administrator; the id is never assumed", async () => {
  const ok = { user_id: 42, is_active: 1, role_name: "Administrator" };
  assert.deepEqual(await resolveEvalAdmin({ db: fakeDb({ adminRow: ok }) }), { role: "admin", userId: 42 });
  await assert.rejects(() => resolveEvalAdmin({ db: fakeDb() }), /not found/);
  await assert.rejects(() => resolveEvalAdmin({ db: fakeDb({ adminRow: { ...ok, is_active: 0 } }) }), /active Administrator/);
  await assert.rejects(() => resolveEvalAdmin({ db: fakeDb({ adminRow: { ...ok, role_name: "Investigator" } }) }), /active Administrator/);
  await assert.rejects(() => resolveEvalAdmin({ db: fakeDb({ adminRow: ok }), expectedId: 1 }), /does not match/);
  assert.equal((await resolveEvalAdmin({ db: fakeDb({ adminRow: ok }), expectedId: "42" })).userId, 42);
  await assert.rejects(() => resolveEvalAdmin({ db: fakeDb({ dbName: "tracex", adminRow: ok }) }), EvalSafetyError);
});

test("record map: exact match required; a foreign or missing record aborts", async () => {
  const recs = tierRecords(ds, 500);
  const rowsFor = (list) => ({ withSession: async (_s, fn) => fn({ query: async () => list.map((r, i) => ({ evidence_id: i + 1, sha256: r.sha256, status: "active" })) }) });
  const map = await buildIdMap({ db: rowsFor(recs), session: ADMIN, dataset: ds, size: 500 });
  assert.equal(map.size, 500);
  await assert.rejects(() => buildIdMap({ db: rowsFor(recs.slice(1)), session: ADMIN, dataset: ds, size: 500 }), /Expected 500/);
  await assert.rejects(() => buildIdMap({ db: rowsFor([...recs, { sha256: "f".repeat(64) }]), session: ADMIN, dataset: ds, size: 500 }), /not in the evaluation dataset/);
  assert.throws(() => assertOnlyEvalCases([{ case_id: 1, case_number: "TX-2026-001" }], 500), EvalSafetyError);
});

function indexFixture({ collection = "tracex_eval_500", dbName = "tracex_eval_500", workerDb = dbName, pending = 500, points = 500, unindexed = 0, failed = 0 } = {}) {
  const calls = { deleted: [], ensured: 0, drained: 0 };
  const db = { withSession: async (s, fn) => fn({ query: async (sql) => {
    if (/DATABASE\(\)/.test(sql)) return [{ db: s.role === "worker" ? workerDb : dbName }];
    if (/status = 'pending'/.test(sql)) return [{ pending }];
    if (/status <> 'done'/.test(sql)) return [{ left_over: 0 }];
    if (/indexed_version IS NULL/.test(sql)) return [{ unindexed }];
    throw new Error(sql);
  } }) };
  const store = { name: collection, client: { collectionExists: async () => ({ exists: true }), deleteCollection: async (n) => calls.deleted.push(n) }, ensureCollection: async () => { calls.ensured += 1; }, countPoints: async () => points };
  const worker = { drain: async () => { calls.drained += 1; return { claimed: 500, upserted: 500, failed, outage: false }; } };
  return { calls, args: { db, adminSession: ADMIN, workerSession: { role: "worker", userId: null }, worker, store, expectedRecords: 500 } };
}

test("indexer: happy path recreates only the evaluation collection and verifies counts", async () => {
  const f = indexFixture();
  const res = await indexEvalCollection(f.args);
  assert.deepEqual(f.calls.deleted, ["tracex_eval_500"]);
  assert.equal(f.calls.drained, 1);
  assert.equal(res.points, 500);
});

test("indexer: refuses a development collection before touching anything", async () => {
  const f = indexFixture({ collection: "tracex_records" });
  await assert.rejects(() => indexEvalCollection(f.args), EvalSafetyError);
  assert.deepEqual(f.calls, { deleted: [], ensured: 0, drained: 0 });
});

test("indexer: the worker connection must also be on the evaluation database", async () => {
  const f = indexFixture({ workerDb: "tracex" });
  await assert.rejects(() => indexEvalCollection(f.args), EvalSafetyError);
  assert.equal(f.calls.drained, 0);
});

test("indexer: refuses when the queue is not exactly this dataset's jobs (e.g. wrong database)", async () => {
  const f = indexFixture({ pending: 57 });
  await assert.rejects(() => indexEvalCollection(f.args), /Expected 500 pending/);
  assert.equal(f.calls.drained, 0);
  assert.deepEqual(f.calls.deleted, []);
});

test("indexer: fails loudly on worker failures or an incomplete index", async () => {
  await assert.rejects(() => indexEvalCollection(indexFixture({ failed: 2 }).args), /did not complete/);
  await assert.rejects(() => indexEvalCollection(indexFixture({ points: 499 }).args), /verification failed/);
  await assert.rejects(() => indexEvalCollection(indexFixture({ unindexed: 1 }).args), /verification failed/);
});
