// Unit tests for semantic retrieval (Phase 3). Everything is mocked: no MySQL, no Qdrant, no
// embedding model. They show how the code behaves given those fakes; they are NOT evidence
// that the real services behave the same way (see tests/retrieval/live.test.mjs for that).
//
//   cd app && npm run test:retrieval

import test from "node:test";
import assert from "node:assert/strict";
import { validateSearchRequest } from "../../src/lib/retrieval/validation.js";
import { RETRIEVAL_LIMITS } from "../../src/lib/retrieval/config.js";
import { parseHits, checkCandidate, reconcile, DISCARD } from "../../src/lib/retrieval/candidates.js";
import { createRetrievalRepository } from "../../src/lib/retrieval/repository.js";
import { createSearchService } from "../../src/lib/retrieval/service.js";
import { createSemanticSearchHandler } from "../../src/lib/retrieval/handlers.js";
import { RetrievalError, toSearchError } from "../../src/lib/retrieval/errors.js";
import { createVectorStore } from "../../src/lib/vector/qdrant.js";
import { loadVectorConfig } from "../../src/lib/vector/config.js";
import { VectorError } from "../../src/lib/vector/errors.js";
import { DatabaseError } from "../../src/lib/db/errors.js";
import { pointId } from "../../src/lib/vector/ids.js";
import { authorizeRequest } from "../../src/lib/auth/access.js";
import { createSessionToken } from "../../src/lib/auth/session.js";
import { SESSION_COOKIE_NAME } from "../../src/lib/auth/config.js";
import {
  createFakeMysql, fakeVector, hit, qdrantDown, sampleData, silentLogger, VEC,
} from "./helpers.mjs";

const INV = (userId) => ({ role: "investigator", userId });
const ADM = (userId) => ({ role: "admin", userId });
const params = (over = {}) => ({ query: "deleted browser history", caseIds: null, kind: "all", limit: 10, minScore: undefined, ...over });

function build({ data, vector = {}, failOn } = {}) {
  const mysql = createFakeMysql(data ?? sampleData(), { failOn });
  const v = fakeVector(vector);
  const service = createSearchService({
    repo: createRetrievalRepository({ db: mysql.db }),
    getVector: v.getVector,
    logger: silentLogger,
  });
  return { mysql, v, service };
}
const keys = (results) => results.map((r) => `${r.record_type}:${r.record_id}`);

// ======================================================================================
// Validation: empty and malformed queries, bad parameters
// ======================================================================================
test("validation: a minimal request gets safe defaults", () => {
  const r = validateSearchRequest({ query: "  usb drive copied files  " });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { query: "usb drive copied files", caseIds: null, kind: "all", limit: 10, minScore: undefined });
});

test("validation: empty, blank, missing and non-string queries are rejected", () => {
  for (const body of [{}, { query: "" }, { query: "   \n\t " }, { query: null }, { query: 42 }, { query: ["a"] }, { query: {} }]) {
    const r = validateSearchRequest(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.field, "query");
  }
});

test("validation: over-long and control-character queries are rejected", () => {
  assert.equal(validateSearchRequest({ query: "a".repeat(RETRIEVAL_LIMITS.maxQueryChars) }).ok, true);
  assert.equal(validateSearchRequest({ query: "a".repeat(RETRIEVAL_LIMITS.maxQueryChars + 1) }).ok, false);
  assert.equal(validateSearchRequest({ query: "abc\u0000def" }).ok, false);
  assert.equal(validateSearchRequest({ query: "abc\u001bdef" }).ok, false);
  assert.equal(validateSearchRequest({ query: "ab\ud800cd" }).ok, false, "lone surrogate");
  assert.equal(validateSearchRequest({ query: "line one\nline two\tok" }).ok, true);
});

test("validation: body must be a JSON object; unknown fields are refused", () => {
  for (const body of [null, undefined, "query", 5, [], [{ query: "x" }]]) {
    assert.equal(validateSearchRequest(body).ok, false);
  }
  assert.equal(validateSearchRequest({ query: "x", caseId: 1 }).ok, false, "typo of case_id");
  assert.equal(validateSearchRequest({ query: "x", sql: "1=1" }).ok, false);
  assert.equal(validateSearchRequest(JSON.parse('{"query":"x","__proto__":{"a":1}}')).ok, false);
});

test("validation: case context", () => {
  assert.deepEqual(validateSearchRequest({ query: "x", case_id: 7 }).value.caseIds, [7]);
  assert.deepEqual(validateSearchRequest({ query: "x", case_ids: [9, 3, 9, 3, 5] }).value.caseIds, [3, 5, 9], "deduplicated and sorted");
  for (const bad of [
    { case_ids: [] }, { case_ids: "1" }, { case_ids: [0] }, { case_ids: [-1] }, { case_ids: [1.5] },
    { case_ids: ["1"] }, { case_ids: [4294967296] }, { case_ids: [null] }, { case_ids: [1e21] },
    { case_id: "1" }, { case_id: 0 }, { case_id: 2.2 }, { case_id: null }, { case_id: 1, case_ids: [1] },
    { case_ids: Array.from({ length: RETRIEVAL_LIMITS.maxCaseIds + 1 }, (_, i) => i + 1) },
  ]) {
    assert.equal(validateSearchRequest({ query: "x", ...bad }).ok, false, JSON.stringify(bad).slice(0, 60));
  }
});

test("validation: kind, limit and min_score", () => {
  assert.equal(validateSearchRequest({ query: "x", kind: "finding" }).value.kind, "finding");
  for (const kind of ["", "Evidence", "case", 1, null]) assert.equal(validateSearchRequest({ query: "x", kind }).ok, false);
  assert.equal(validateSearchRequest({ query: "x", limit: 50 }).value.limit, 50);
  for (const limit of [0, 51, -1, 1.5, "10", null, NaN]) assert.equal(validateSearchRequest({ query: "x", limit }).ok, false);
  assert.equal(validateSearchRequest({ query: "x", min_score: 0.5 }).value.minScore, 0.5);
  for (const min_score of [-0.1, 1.1, "0.5", NaN, null]) assert.equal(validateSearchRequest({ query: "x", min_score }).ok, false);
});

// ======================================================================================
// Candidate parsing and per-candidate checks (pure)
// ======================================================================================
test("parseHits: keeps valid hits, drops foreign payloads, forged point ids, bad scores and duplicates", () => {
  const good = hit("evidence", 10, { caseId: 1 });
  const forgedId = { ...hit("evidence", 11, { caseId: 1 }), id: pointId("evidence", 999) };
  const foreign = { id: "x", score: 0.9, payload: { hello: "world" } };
  const nanScore = { ...hit("evidence", 12, { caseId: 1 }), score: NaN };
  const dup = hit("evidence", 10, { caseId: 1 });
  const nullPayload = { id: pointId("evidence", 13), score: 0.5, payload: null };
  const { candidates, malformed } = parseHits([good, forgedId, foreign, nanScore, dup, nullPayload]);
  assert.deepEqual(candidates.map((c) => c.recordId), [10]);
  assert.equal(malformed, 5);
  assert.deepEqual(parseHits(undefined), { candidates: [], malformed: 0 });
});

test("checkCandidate: every rule discards for the right reason", () => {
  const cand = (over = {}) => ({ kind: "evidence", recordId: 10, score: 0.9, payload: { caseId: 1, evidenceId: 10, contentVersion: 1, ...over } });
  const row = (over = {}) => ({ kind: "evidence", recordId: 10, evidenceId: 10, caseId: 1, status: "active", contentVersion: 1, ...over });
  assert.deepEqual(checkCandidate(cand(), row(), [1]), { ok: true });
  assert.equal(checkCandidate(cand(), undefined, [1]).reason, DISCARD.NO_ROW);
  assert.equal(checkCandidate(cand(), row({ caseId: 2 }), [1]).reason, DISCARD.OUT_OF_SCOPE);
  assert.equal(checkCandidate(cand(), row({ status: "withdrawn" }), [1]).reason, DISCARD.WITHDRAWN);
  assert.equal(checkCandidate(cand({ caseId: 5 }), row(), [1, 5]).reason, DISCARD.CASE_MISMATCH);
  assert.equal(checkCandidate(cand({ evidenceId: 77 }), row(), [1]).reason, DISCARD.EVIDENCE_MISMATCH);
  assert.equal(checkCandidate(cand({ contentVersion: 1 }), row({ contentVersion: 2 }), [1]).reason, DISCARD.STALE);
  assert.equal(checkCandidate(cand({ contentVersion: 3 }), row({ contentVersion: 2 }), [1]).reason, DISCARD.STALE, "payload ahead of MySQL is also inconsistent");
  assert.equal(checkCandidate(cand({ contentVersion: 1 }), row({ contentVersion: null }), [1]).ok, true, "version unavailable: cannot be checked");
  // a null payload case_id is only a missing hint; MySQL's case_id still must be in scope
  assert.equal(checkCandidate(cand({ caseId: null }), row(), [1]).ok, true);
});

test("reconcile: results come only from rows, best score first, limited, ranked from 1", () => {
  const candidates = [
    { kind: "evidence", recordId: 1, score: 0.9, payload: { caseId: 1, evidenceId: 1, contentVersion: 1 } },
    { kind: "evidence", recordId: 2, score: 0.8, payload: { caseId: 1, evidenceId: 2, contentVersion: 1 } },
    { kind: "evidence", recordId: 3, score: 0.7, payload: { caseId: 1, evidenceId: 3, contentVersion: 1 } },
  ];
  const mk = (id, over = {}) => ({ kind: "evidence", recordId: id, evidenceId: id, evidenceNo: `EV-${id}`, caseId: 1, typeId: 1, title: `t${id}`, status: "active", registeredAt: null, contentVersion: null, ...over });
  const { results, discarded } = reconcile({
    candidates, rows: { evidence: [mk(1), mk(3)], findings: [] }, scopeCaseIds: [1], limit: 1,
  });
  assert.deepEqual(results.map((r) => [r.rank, r.record_id]), [[1, 1]]);
  assert.deepEqual(discarded, { [DISCARD.NO_ROW]: 1 });
});

// ======================================================================================
// Service + repository + REAL lib/db client over a fake MySQL connection
// ======================================================================================
test("authorized investigator gets MySQL-backed results with score, type and identifiers", async () => {
  const { service, v } = build({
    vector: { hits: [hit("evidence", 10, { caseId: 1, score: 0.91 }), hit("finding", 1000, { caseId: 1, evidenceId: 10, score: 0.84 })] },
  });
  const out = await service.search(INV(3), params());
  assert.deepEqual(keys(out.results), ["evidence:10", "finding:1000"]);
  const [ev, fi] = out.results;
  assert.equal(ev.rank, 1);
  assert.equal(ev.similarity_score, 0.91);
  assert.equal(ev.evidence_no, "EV-0010");
  assert.equal(ev.title, "Laptop image");
  assert.equal(ev.case_id, 1);
  assert.equal(fi.evidence_id, 10);
  assert.equal(fi.analysis_id, 100);
  assert.equal(fi.severity, "high");
  assert.equal(out.meta.verification.authority, "mysql");
  assert.equal(out.meta.verification.access_path, "investigator_views");
  assert.match(out.meta.notice, /not proof/);
  // Qdrant was asked for exactly the user's cases (MySQL's answer), with the query embedded once
  assert.deepEqual(v.calls.search[0].caseIds, [1]);
  assert.equal(v.calls.embed.length, 1);
  // no evidence content is returned
  for (const r of out.results) for (const k of Object.keys(r)) assert.ok(!["description", "extracted_text", "sha256"].includes(k));
});

test("no case_ids: the search covers every case MySQL says the user may access, nothing more", async () => {
  const { service, v } = build({ vector: { hits: [] } });
  await service.search(INV(4), params());
  assert.deepEqual(v.calls.search[0].caseIds, [1, 2]);
  const r = build({ vector: { hits: [] } });
  await r.service.search(INV(3), params());
  assert.deepEqual(r.v.calls.search[0].caseIds, [1], "case 3 assignment was revoked");
});

test("per-request DB pattern: investigator pool, SET @tracex_user_id first with the user id, reset and released", async () => {
  const { service, mysql } = build({ vector: { hits: [hit("evidence", 10, { caseId: 1 })] } });
  await service.search(INV(3), params());
  // two connections: scope lookup and re-validation; both investigator pool, never admin
  assert.equal(mysql.checkouts.length, 2);
  assert.ok(mysql.checkouts.every((c) => c.role === "investigator" && c.released && !c.destroyed));
  // on each connection the first statement is the SET with the user id, before any SELECT
  assert.equal(mysql.log[0].sql, "SET @tracex_user_id = ?");
  assert.deepEqual(mysql.log[0].params, [3]);
  const selects = mysql.log.filter((l) => /^\s*SELECT/i.test(l.sql));
  assert.ok(selects.length >= 2);
  assert.ok(selects.every((l) => l.userVar === 3), "every SELECT ran with @tracex_user_id = 3");
  assert.ok(mysql.checkouts.every((c) => c.userVarAtRelease === null), "identity cleared before the connection went back");
  const sets = mysql.log.filter((l) => l.sql === "SET @tracex_user_id = ?");
  assert.equal(sets.length, 4, "two SET ... = <user id>, two reset to NULL");
  assert.deepEqual(sets.map((l) => l.params[0]), [3, null, 3, null]);
});

test("inaccessible case: requesting it is refused (403) before any embedding or Qdrant call", async () => {
  const { service, v, mysql } = build({ vector: { hits: [hit("evidence", 30, { caseId: 3 })] } });
  await assert.rejects(
    () => service.search(INV(3), params({ caseIds: [3] })), // Isha's assignment to case 3 was revoked
    (e) => e instanceof RetrievalError && e.status === 403 && e.code === "CASE_ACCESS_DENIED",
  );
  await assert.rejects(() => service.search(INV(3), params({ caseIds: [1, 2] })), (e) => e.code === "CASE_ACCESS_DENIED"); // 2 is not hers
  assert.equal(v.calls.embed.length, 0);
  assert.equal(v.calls.search.length, 0);
  assert.ok(!mysql.log.some((l) => /FROM v_my_evidence|FROM v_my_findings/.test(l.sql)), "no record was read");
});

test("a case that does not exist gets exactly the same refusal as one the user cannot access", async () => {
  const { service } = build({ vector: { hits: [] } });
  const get = (ids) => service.search(INV(3), params({ caseIds: ids })).then(() => null, (e) => e);
  const notMine = await get([2]);
  const missing = await get([999]);
  assert.deepEqual(notMine.toResponseBody(), missing.toResponseBody());
  assert.equal(notMine.status, missing.status);
});

test("Qdrant returns a hit from a case the user cannot access (filter ignored / stale): it is discarded", async () => {
  const { service } = build({
    vector: { hits: [hit("evidence", 30, { caseId: 3, score: 0.99 }), hit("evidence", 20, { caseId: 2, score: 0.95 }), hit("evidence", 10, { caseId: 1, score: 0.7 })] },
  });
  const out = await service.search(INV(3), params());
  assert.deepEqual(keys(out.results), ["evidence:10"], "only case 1 is Isha's");
  assert.equal(out.meta.discarded, 2);
  assert.equal(out.meta.candidates_examined, 3);
});

test("access revoked WHILE the query is being embedded/searched: the re-check catches it", async () => {
  const data = sampleData();
  const { service } = build({
    data,
    vector: {
      hits: [hit("evidence", 10, { caseId: 1 })],
      onSearch: () => { data.assignments.find((a) => a.case_id === 1 && a.user_id === 3).revoked_at = "2026-11-08"; },
    },
  });
  const out = await service.search(INV(3), params());
  assert.deepEqual(out.results, [], "scope said yes, but the second MySQL read said no");
});

test("withdrawn evidence is discarded, and so are findings of withdrawn evidence", async () => {
  const { service } = build({
    vector: { hits: [hit("evidence", 12, { caseId: 1, score: 0.99 }), hit("finding", 1001, { caseId: 1, evidenceId: 12, score: 0.98 }), hit("evidence", 10, { caseId: 1, score: 0.5 })] },
  });
  const out = await service.search(INV(3), params());
  assert.deepEqual(keys(out.results), ["evidence:10"]);
  assert.equal(out.meta.discarded, 2);
});

test("stale Qdrant candidate: point with no MySQL row (never existed / hard-deleted) is discarded", async () => {
  const { service } = build({ vector: { hits: [hit("evidence", 777, { caseId: 1, score: 0.99 }), hit("finding", 4242, { caseId: 1, evidenceId: 10, score: 0.9 })] } });
  const out = await service.search(INV(3), params());
  assert.deepEqual(out.results, []);
  assert.equal(out.meta.discarded, 2);
});

test("stale payload case_id / evidence_id that disagree with MySQL are discarded", async () => {
  const { service } = build({
    vector: { hits: [hit("evidence", 10, { caseId: 2, score: 0.9 }), hit("finding", 1000, { caseId: 1, evidenceId: 11, score: 0.8 })] },
  });
  // Tomas may see cases 1 and 2. Evidence 10 is in case 1 but its payload says case 2, and
  // finding 1000 belongs to evidence 10 but its payload says evidence 11: both disagree with MySQL.
  const out = await service.search(INV(4), params());
  assert.deepEqual(out.results, []);
});

test("admin: stale-version candidates ARE discarded (MySQL content_version differs from the payload)", async () => {
  const { service } = build({
    vector: { hits: [hit("evidence", 11, { caseId: 1, version: 1, score: 0.9 }), hit("evidence", 10, { caseId: 1, version: 1, score: 0.8 })] },
  });
  const out = await service.search(ADM(1), params());
  assert.deepEqual(keys(out.results), ["evidence:10"], "evidence 11 is at version 2 in MySQL, payload says 1");
  assert.equal(out.meta.verification.access_path, "admin_base_tables");
  assert.equal(out.meta.verification.stale_version_check, true);
});

test("investigators: stale evidence and finding vectors are discarded using MySQL content_version", async () => {
  const { service } = build({
    vector: { hits: [
      hit("evidence", 11, { caseId: 1, version: 1, score: 0.99 }),
      hit("finding", 1004, { caseId: 1, evidenceId: 10, version: 1, score: 0.98 }),
      hit("evidence", 10, { caseId: 1, version: 1, score: 0.8 }),
      hit("finding", 1000, { caseId: 1, evidenceId: 10, version: 1, score: 0.7 }),
    ] },
  });
  const out = await service.search(INV(3), params());
  assert.deepEqual(keys(out.results), ["evidence:10", "finding:1000"]);
  assert.equal(out.meta.verification.access_path, "investigator_views");
  assert.equal(out.meta.verification.stale_version_check, true);
  assert.equal(out.meta.discarded, 2);
});

test("deactivated investigator and investigator with no cases get nothing, without embedding or searching", async () => {
  for (const id of [5, 6]) {
    const { service, v } = build({ vector: { hits: [hit("evidence", 20, { caseId: 2 })] } });
    const out = await service.search(INV(id), params());
    assert.deepEqual(out.results, []);
    assert.equal(out.meta.verification.access_path, "none");
    assert.equal(v.calls.embed.length + v.calls.search.length, 0);
  }
  // ...and an explicit request for a case is a refusal, not an empty list
  const { service } = build();
  await assert.rejects(() => service.search(INV(5), params({ caseIds: [2] })), (e) => e.status === 403);
});

test("admin: searches every case, but only while MySQL says the user is an ACTIVE Administrator", async () => {
  const h = [hit("evidence", 30, { caseId: 3, score: 0.9 }), hit("finding", 1002, { caseId: 2, evidenceId: 20, score: 0.8 })];
  const ok = build({ vector: { hits: h } });
  const out = await ok.service.search(ADM(1), params());
  assert.deepEqual(keys(out.results), ["evidence:30", "finding:1002"]);
  assert.deepEqual(ok.v.calls.search[0].caseIds, [1, 2, 3]);
  assert.ok(ok.mysql.checkouts.every((c) => c.role === "admin"));

  for (const [label, session] of [["deactivated admin", ADM(2)], ["investigator holding an admin cookie", ADM(7)], ["unknown user", ADM(999)]]) {
    const t = build({ vector: { hits: h } });
    await assert.rejects(() => t.service.search(session, params()), (e) => e.status === 403 && e.code === "AUTH_FORBIDDEN", label);
    assert.equal(t.v.calls.embed.length, 0, label);
  }
});

test("admin whose access ends while the query is running gets no results (re-checked on the second read)", async () => {
  const data = sampleData();
  const { service } = build({
    data,
    vector: { hits: [hit("evidence", 10, { caseId: 1 })], onSearch: () => { data.users[0].is_active = 0; } },
  });
  await assert.rejects(() => service.search(ADM(1), params()), (e) => e.code === "AUTH_FORBIDDEN");
});

test("the worker role and unknown roles are refused", async () => {
  const { service } = build({ vector: { hits: [] } });
  await assert.rejects(() => service.search({ role: "worker", userId: 1 }, params()), (e) => e.status === 403);
  await assert.rejects(() => service.search({ role: "root", userId: 1 }, params()), (e) => e.status === 403 || e.status === 500);
});

// ---- failure modes ---------------------------------------------------------------------
test("Qdrant outage: 503, no results, no record read from MySQL", async () => {
  const { service, mysql } = build({ vector: { searchError: qdrantDown() } });
  await assert.rejects(() => service.search(INV(3), params()), (e) => e.code === "QDRANT_UNAVAILABLE" && e.status === 503);
  assert.ok(!mysql.log.some((l) => /v_my_evidence e|v_my_findings f/.test(l.sql)));
});

test("Qdrant outage through the REAL store: network error is mapped, nothing leaks", async () => {
  const cause = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const store = createVectorStore({
    config: loadVectorConfig({ QDRANT_URL: "http://user:@127.0.0.1:1".replace("user:@", "") }),
    client: { query: async () => { throw cause; } },
  });
  const mysql = createFakeMysql();
  const service = createSearchService({
    repo: createRetrievalRepository({ db: mysql.db }),
    getVector: () => ({ embedder: { embedQuery: async () => VEC }, store }),
    logger: silentLogger,
  });
  await assert.rejects(() => service.search(INV(3), params()), (e) => {
    assert.equal(e.code, "QDRANT_UNAVAILABLE");
    assert.equal(e.status, 503);
    assert.ok(!JSON.stringify(e.toResponseBody()).includes("127.0.0.1"));
    return true;
  });
});

test("real store receives the MySQL-resolved case filter and the kind filter", async () => {
  let seen;
  const store = createVectorStore({
    config: loadVectorConfig({ QDRANT_URL: "http://127.0.0.1:6333" }),
    client: { query: async (_name, body) => { seen = body; return { points: [] }; } },
  });
  const mysql = createFakeMysql();
  const service = createSearchService({
    repo: createRetrievalRepository({ db: mysql.db }),
    getVector: () => ({ embedder: { embedQuery: async () => VEC }, store }),
    logger: silentLogger,
  });
  await service.search(INV(4), params({ kind: "finding", limit: 5, minScore: 0.4 }));
  assert.deepEqual(seen.filter.must, [{ key: "case_id", match: { any: [1, 2] } }, { key: "kind", match: { value: "finding" } }]);
  assert.equal(seen.limit, 15);
  assert.equal(seen.score_threshold, 0.4);
  assert.equal(seen.with_vector, false);
});

test("embedding failure and model-unavailable: mapped, Qdrant never called", async () => {
  for (const [err, code, status] of [
    [new VectorError("EMBEDDING_MODEL_UNAVAILABLE", "The embedding model could not be loaded.", { status: 503 }), "EMBEDDING_MODEL_UNAVAILABLE", 503],
    [new VectorError("EMBEDDING_FAILED", "The embedding model failed on this input.", { status: 500 }), "EMBEDDING_FAILED", 500],
  ]) {
    const { service, v } = build({ vector: { embedError: err } });
    await assert.rejects(() => service.search(INV(3), params()), (e) => e.code === code && e.status === status);
    assert.equal(v.calls.search.length, 0);
  }
});

test("database failure when resolving cases: 503, no embedding, no Qdrant", async () => {
  const { service, v } = build({ vector: { hits: [hit("evidence", 10, { caseId: 1 })] }, failOn: (sql) => /FROM v_my_cases/.test(sql) });
  await assert.rejects(() => service.search(INV(3), params()), (e) => e.code === "DB_UNAVAILABLE" && e.status === 503);
  assert.equal(v.calls.embed.length + v.calls.search.length, 0);
});

test("FAIL CLOSED: database failure during re-validation returns NO results even though Qdrant returned hits", async () => {
  const { service, v } = build({
    vector: { hits: [hit("evidence", 10, { caseId: 1, score: 0.99 }), hit("finding", 1000, { caseId: 1, evidenceId: 10 })] },
    failOn: (sql) => /FROM v_my_evidence e/.test(sql) && /IN \(/.test(sql),
  });
  let out;
  await assert.rejects(async () => { out = await service.search(INV(3), params()); }, (e) => e.code === "DB_UNAVAILABLE" && e.status === 503);
  assert.equal(out, undefined);
  assert.equal(v.calls.search.length, 1, "Qdrant was reached; its hits were never returned");
});

test("FAIL CLOSED: a database permission error (investigator pool cannot read a view) returns no results", async () => {
  const { service } = build({
    vector: { hits: [hit("evidence", 10, { caseId: 1 })] },
    failOn: Object.assign((sql) => /v_my_evidence e/.test(sql) && /IN \(/.test(sql), {
      error: Object.assign(new Error("denied"), { errno: 1142, code: "ER_TABLEACCESS_DENIED_ERROR", sqlState: "42000", sqlMessage: "SELECT command denied" }),
    }),
  });
  await assert.rejects(() => service.search(INV(3), params()), (e) => e.code === "DB_PERMISSION_DENIED" && e.status === 403);
});

test("an unexpected programming error becomes a generic 500 with no detail", async () => {
  const { service } = build({ vector: { hits: () => { throw new TypeError("secret internals SELECT * FROM evidence"); } } });
  await assert.rejects(() => service.search(INV(3), params()), (e) => {
    assert.equal(e.status, 500);
    assert.equal(e.code, "SEARCH_ERROR");
    assert.ok(!JSON.stringify(e.toResponseBody()).includes("secret"));
    return true;
  });
});

test("Qdrant returning no candidates, or only malformed ones, is an empty result without a MySQL read of records", async () => {
  for (const hits of [[], [{ id: "nope", score: 1, payload: { kind: "case", record_id: 1 } }], undefined]) {
    const { service, mysql } = build({ vector: { hits: hits ?? [] } });
    const out = await service.search(INV(3), params());
    assert.deepEqual(out.results, []);
    assert.ok(!mysql.log.some((l) => /v_my_evidence e|v_my_findings f/.test(l.sql)));
  }
});

test("over-fetch: Qdrant is asked for more than the limit (capped), results are cut to the limit", async () => {
  const ids = [10, 11];
  const { service, v } = build({ vector: { hits: ids.map((id, i) => hit("evidence", id, { caseId: 1, score: 0.9 - i / 10 })) } });
  const out = await service.search(INV(3), params({ limit: 1 }));
  assert.equal(v.calls.search[0].limit, 11, "max(1 x 3, 1 + 10)");
  assert.equal(out.results.length, 1);
  assert.equal(out.meta.discarded, 0, "cutting to the limit is not a discard");
  await service.search(INV(3), params({ limit: 50 }));
  assert.equal(v.calls.search[1].limit, 150);
  assert.equal(RETRIEVAL_LIMITS.maxLimit * RETRIEVAL_LIMITS.overfetchFactor <= RETRIEVAL_LIMITS.maxCandidates, true);
});

test("kind 'all' sends no kind filter; a specific kind is passed through", async () => {
  const a = build({ vector: { hits: [] } });
  await a.service.search(INV(3), params({ kind: "all" }));
  assert.equal(a.v.calls.search[0].kind, undefined);
  const b = build({ vector: { hits: [] } });
  await b.service.search(INV(3), params({ kind: "evidence" }));
  assert.equal(b.v.calls.search[0].kind, "evidence");
});

// ======================================================================================
// The central guarantee, checked exhaustively on the fake data
// ======================================================================================
test("AUTHORIZATION ORACLE: even if Qdrant returns EVERY point, no user gets a record they may not see", async () => {
  const data = sampleData();
  const allHits = [
    ...data.evidence.map((e, i) => hit("evidence", e.evidence_id, { caseId: e.case_id, version: 1, score: 0.99 - i / 100 })),
    ...data.findings.map((f, i) => {
      const e = data.evidence.find((x) => x.evidence_id === data.analyses.find((a) => a.analysis_id === f.analysis_id).evidence_id);
      return hit("finding", f.finding_id, { caseId: e.case_id, evidenceId: e.evidence_id, score: 0.8 - i / 100 });
    }),
  ];

  // Independent oracle, computed from the raw fake data (not through any SQL).
  function mayRead(session) {
    const user = data.users.find((u) => u.user_id === session.userId);
    const activeAdmin = session.role === "admin" && user?.is_active === 1 && user.role_name === "Administrator";
    const myCases = new Set(
      user?.is_active === 1 ? data.assignments.filter((a) => a.user_id === user.user_id && a.revoked_at === null).map((a) => a.case_id) : [],
    );
    const canSeeCase = (c) => (session.role === "admin" ? activeAdmin : myCases.has(c));
    const out = new Set();
    for (const e of data.evidence) if (e.status === "active" && canSeeCase(e.case_id)) out.add(`evidence:${e.evidence_id}`);
    for (const f of data.findings) {
      const e = data.evidence.find((x) => x.evidence_id === data.analyses.find((a) => a.analysis_id === f.analysis_id).evidence_id);
      if (e.status === "active" && canSeeCase(e.case_id)) out.add(`finding:${f.finding_id}`);
    }
    return out;
  }

  for (const session of [INV(3), INV(4), INV(5), INV(6), ADM(1), ADM(2), ADM(7)]) {
    const { service } = build({ vector: { hits: () => allHits } });
    let results = [];
    try {
      results = (await service.search(session, params({ limit: 50 }))).results;
    } catch (e) {
      assert.ok(e instanceof RetrievalError, "refusals are RetrievalErrors");
    }
    const allowed = mayRead(session);
    for (const k of keys(results)) assert.ok(allowed.has(k), `${session.role} ${session.userId} was given ${k} which MySQL would not show them`);
  }

  // and the oracle is not vacuous: investigator 4 really does get results
  const { service } = build({ vector: { hits: () => allHits } });
  const out = await service.search(INV(4), params({ limit: 50 }));
  assert.deepEqual(keys(out.results).sort(), ["evidence:10", "evidence:11", "evidence:20", "finding:1000", "finding:1002"]);
});

test("result fields other than the score come from MySQL, not from the Qdrant payload", async () => {
  const forged = hit("evidence", 10, { caseId: 1, score: 0.9 });
  forged.payload.title = "FORGED TITLE";
  forged.payload.secret = "should never appear";
  const { service } = build({ vector: { hits: [forged] } });
  const out = await service.search(INV(3), params());
  assert.equal(out.results[0].title, "Laptop image");
  assert.ok(!JSON.stringify(out).includes("FORGED"));
  assert.ok(!JSON.stringify(out).includes("should never appear"));
});

// ======================================================================================
// HTTP handler
// ======================================================================================
const SECRET = "x".repeat(40);
const cookie = (user) => `${SESSION_COOKIE_NAME}=${createSessionToken({ username: "u", fullName: "U", ...user }, { secret: SECRET })}`;
const authorize = (req, opts) => authorizeRequest(req, { ...opts, secret: SECRET });
const post = (body, headers = {}) =>
  new Request("http://localhost/api/search/semantic", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function handlerWith(service) {
  return createSemanticSearchHandler({ getService: () => service, authorize, logger: silentLogger });
}

test("handler: no session -> 401 and the service is never called", async () => {
  let called = 0;
  const POST = handlerWith({ search: async () => { called++; } });
  const res = await POST(post({ query: "x" }));
  assert.equal(res.status, 401);
  assert.equal(called, 0);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const tampered = await POST(post({ query: "x" }, { cookie: cookie({ userId: 3, role: "investigator" }) + "AA" }));
  assert.equal(tampered.status, 401);
});

test("handler: missing SESSION_SECRET is a clean 500, not a crash", async () => {
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    const POST = createSemanticSearchHandler({ getService: () => ({ search: async () => ({}) }), logger: silentLogger });
    const res = await POST(post({ query: "x" }));
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "AUTH_CONFIG");
  } finally {
    if (saved !== undefined) process.env.SESSION_SECRET = saved;
  }
});

test("handler: bad JSON, empty query, malformed parameters -> 400 without touching the service", async () => {
  let called = 0;
  const POST = handlerWith({ search: async () => { called++; } });
  const c = { cookie: cookie({ userId: 3, role: "investigator" }) };
  for (const body of ["{not json", "", "null", "[]", '"str"', { query: "" }, { query: "   " }, { query: "x", limit: 0 }, { query: "x", case_ids: [] }, { query: "x", extra: 1 }]) {
    const res = await POST(post(body, c));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error.code, "SEARCH_BAD_REQUEST");
  }
  assert.equal(called, 0);
});

test("handler: oversized body -> 413", async () => {
  const POST = handlerWith({ search: async () => ({}) });
  const res = await POST(post({ query: "a".repeat(20000) }, { cookie: cookie({ userId: 3, role: "investigator" }) }));
  assert.equal(res.status, 413);
});

test("handler: success returns results from the service for the signed-in user only (session comes from the cookie, not the body)", async () => {
  const seen = [];
  const POST = handlerWith({ search: async (session, p) => { seen.push({ session, p }); return { results: [], meta: {} }; } });
  const res = await POST(post({ query: " leaked credentials ", case_id: 1, user_id: 1 }, { cookie: cookie({ userId: 3, role: "investigator" }) }));
  assert.equal(res.status, 400, "a body that tries to name a user is refused");
  const ok = await POST(post({ query: " leaked credentials ", case_id: 1 }, { cookie: cookie({ userId: 3, role: "investigator" }) }));
  assert.equal(ok.status, 200);
  assert.deepEqual(seen.length, 1);
  assert.deepEqual(seen[0].session, { role: "investigator", userId: 3 });
  assert.equal(seen[0].p.query, "leaked credentials");
  assert.deepEqual(seen[0].p.caseIds, [1]);
  assert.equal(ok.headers.get("cache-control"), "no-store");
});

test("handler: service errors become safe JSON with the right status", async () => {
  const c = { cookie: cookie({ userId: 3, role: "investigator" }) };
  const cases = [
    [new RetrievalError("CASE_ACCESS_DENIED", "One or more requested cases are not available to you.", { status: 403 }), 403, "CASE_ACCESS_DENIED"],
    [new VectorError("QDRANT_UNAVAILABLE", "The vector database is not reachable right now.", { status: 503 }), 503, "QDRANT_UNAVAILABLE"],
    [new DatabaseError("DB_UNAVAILABLE", "The database is not reachable right now.", { status: 503 }), 503, "DB_UNAVAILABLE"],
    [new TypeError("boom: password=hunter2 SELECT secret"), 500, "SEARCH_ERROR"],
  ];
  for (const [err, status, code] of cases) {
    const POST = handlerWith({ search: async () => { throw err; } });
    const res = await POST(post({ query: "x" }, c));
    const text = await res.text();
    assert.equal(res.status, status);
    assert.equal(JSON.parse(text).error.code, code);
    assert.ok(!text.includes("hunter2") && !text.includes("SELECT"));
  }
});

test("handler end to end over the fake MySQL: investigator sees their case only", async () => {
  const { service } = build({
    vector: { hits: [hit("evidence", 20, { caseId: 2, score: 0.99 }), hit("evidence", 10, { caseId: 1, score: 0.9 })] },
  });
  const POST = handlerWith(service);
  const res = await POST(post({ query: "laptop" }, { cookie: cookie({ userId: 3, role: "investigator" }) }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(keys(body.results), ["evidence:10"]);
});

test("toSearchError: leaves RetrievalError alone and hides unknown causes", () => {
  const e = new RetrievalError("X", "safe", { status: 418 });
  assert.equal(toSearchError(e), e);
  const g = toSearchError(new Error("internal path /etc/passwd"));
  assert.equal(g.message, "The search could not be completed.");
  assert.equal(g.status, 500);
  assert.equal(new RetrievalError("X", "m", { status: 99 }).status, 500, "invalid HTTP status falls back to 500");
});
