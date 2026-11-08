// Unit tests for the indexing worker. No MySQL, Qdrant or model needed: the repository,
// embedder and vector store are replaced by in-memory fakes, and for the repository's SQL
// the db layer is replaced by a recorder.
//   npm run test:indexing

import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkerConfig } from "../../src/lib/indexing/config.js";
import { createIndexRepository, WORKER_SESSION } from "../../src/lib/indexing/repository.js";
import { createProcessor, targetOf } from "../../src/lib/indexing/processor.js";
import { createWorker } from "../../src/lib/indexing/runner.js";
import { IndexingError, FAILURE, classifyError, formatLastError } from "../../src/lib/indexing/errors.js";
import { VectorError } from "../../src/lib/vector/errors.js";
import { DatabaseError } from "../../src/lib/db/errors.js";
import { pointId, parsePayload } from "../../src/lib/vector/ids.js";

const silent = { info() {}, warn() {}, error() {} };
const CONFIG = { batchSize: 10, maxAttempts: 5, pollIntervalMs: 100, backoffBaseMs: 100, backoffMaxMs: 800, recoverOnStart: true };

const vec = (n = 1) => { const v = new Array(384).fill(0); v[n % 384] = 1; return v; };

// ---- fakes ---------------------------------------------------------------
function makeWorld({ evidence = [], findings = [], jobs = [] } = {}) {
  const w = {
    evidence: new Map(evidence.map((e) => [e.evidence_id, { status: "active", content_version: 1, case_id: 1, extracted_text: null, indexed_version: null, ...e }])),
    findings: new Map(findings.map((f) => [f.finding_id, { evidence_status: "active", content_version: 1, case_id: 1, evidence_id: 1, indexed_version: null, ...f }])),
    jobs: new Map(jobs.map((j) => [j.job_id, { evidence_id: null, finding_id: null, operation: "upsert", content_version: 1, status: "processing", attempts: 1, last_error: null, ...j }])),
    points: new Map(),
    calls: [],
    failEmbed: null, // (texts) => Error | undefined
    failUpsert: null,
    failDelete: null,
    failFetch: null,
    failFetchEvidence: null,
    failFetchFindings: null,
    failMarkIndexed: null,
  };

  w.repo = {
    async fetchEvidence(ids) { w.calls.push(["fetchEvidence", ids]); if (w.failFetchEvidence ?? w.failFetch) throw (w.failFetchEvidence ?? w.failFetch); return new Map(ids.filter((i) => w.evidence.has(i)).map((i) => [i, w.evidence.get(i)])); },
    async fetchFindings(ids) { w.calls.push(["fetchFindings", ids]); if (w.failFetchFindings ?? w.failFetch) throw (w.failFetchFindings ?? w.failFetch); return new Map(ids.filter((i) => w.findings.has(i)).map((i) => [i, w.findings.get(i)])); },
    async markIndexed(kind, id, version) {
      if (w.failMarkIndexed) throw w.failMarkIndexed;
      const row = (kind === "evidence" ? w.evidence : w.findings).get(id);
      if (row.indexed_version === null || row.indexed_version <= version) row.indexed_version = version;
    },
    async markJobDone(id, note = null) { const j = w.jobs.get(id); j.status = "done"; j.last_error = note ? `skipped: ${note}` : null; },
    async releaseJob(id, err, { countAttempt = true } = {}) { const j = w.jobs.get(id); j.status = "pending"; j.last_error = err; if (!countAttempt) j.attempts = Math.max(j.attempts - 1, 0); },
    async markJobFailed(id, err) { const j = w.jobs.get(id); j.status = "failed"; j.last_error = err; },
  };
  w.embedder = {
    async embedDocuments(texts) {
      w.calls.push(["embed", texts.length]);
      const err = w.failEmbed?.(texts);
      if (err) throw err;
      return texts.map((_, i) => vec(i + 1));
    },
  };
  w.store = {
    async upsertPoints(points) { if (w.failUpsert) throw w.failUpsert; for (const p of points) w.points.set(p.id, p); },
    async deletePoints(ids) { if (w.failDelete) throw w.failDelete; for (const id of ids) w.points.delete(id); },
  };
  w.processor = createProcessor({ repo: w.repo, embedder: w.embedder, store: w.store, config: CONFIG, logger: silent });
  w.claimed = () => [...w.jobs.values()].filter((j) => j.status === "processing");
  return w;
}

const ev = (id, extra = {}) => ({ evidence_id: id, title: `Evidence ${id}`, description: `Description ${id}`, ...extra });

// ---- targetOf ------------------------------------------------------------
test("targetOf: exactly one of evidence_id / finding_id", () => {
  assert.deepEqual(targetOf({ evidence_id: 4, finding_id: null }), { kind: "evidence", recordId: 4 });
  assert.deepEqual(targetOf({ evidence_id: null, finding_id: 9 }), { kind: "finding", recordId: 9 });
  assert.equal(targetOf({ evidence_id: null, finding_id: null }), null);
  assert.equal(targetOf({ evidence_id: 1, finding_id: 2 }), null);
  assert.equal(targetOf({ evidence_id: 0, finding_id: null }), null);
});

// ---- upsert --------------------------------------------------------------
test("evidence upsert: embeds MySQL text, uses the convention ID + payload, records indexed_version, closes the job", async () => {
  const w = makeWorld({ evidence: [ev(7, { case_id: 3, content_version: 2, extracted_text: "extracted body" })], jobs: [{ job_id: 1, evidence_id: 7, content_version: 2 }] });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.upserted, 1);
  const p = w.points.get(pointId("evidence", 7));
  assert.ok(p, "point stored under the deterministic ID");
  assert.deepEqual(p.payload, { kind: "evidence", record_id: 7, evidence_id: 7, case_id: 3, content_version: 2 });
  assert.deepEqual(Object.keys(p.payload).sort(), ["case_id", "content_version", "evidence_id", "kind", "record_id"]);
  assert.ok(!JSON.stringify(p.payload).includes("Evidence 7"), "no text in payload");
  assert.ok(parsePayload(p.payload));
  assert.equal(w.evidence.get(7).indexed_version, 2);
  assert.equal(w.jobs.get(1).status, "done");
  assert.equal(w.jobs.get(1).last_error, null);
});

test("finding upsert: payload carries evidence_id and case_id resolved from MySQL", async () => {
  const w = makeWorld({ findings: [{ finding_id: 5, title: "F", description: "D", evidence_id: 7, case_id: 3, content_version: 1 }], jobs: [{ job_id: 1, finding_id: 5 }] });
  await w.processor.processBatch(w.claimed());
  const p = w.points.get(pointId("finding", 5));
  assert.deepEqual(p.payload, { kind: "finding", record_id: 5, evidence_id: 7, case_id: 3, content_version: 1 });
  assert.equal(w.findings.get(5).indexed_version, 1);
});

// ---- idempotency / duplicates --------------------------------------------
test("processing the same job twice leaves exactly one point (idempotent)", async () => {
  const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1 }] });
  await w.processor.processBatch(w.claimed());
  w.jobs.get(1).status = "processing"; // simulate redelivery after a crash
  await w.processor.processBatch(w.claimed());
  assert.equal(w.points.size, 1);
  assert.equal(w.evidence.get(1).indexed_version, 1);
});

test("duplicate jobs for one record in a batch: only the newest works, older are closed as duplicates", async () => {
  const w = makeWorld({ evidence: [ev(1, { content_version: 2 })], jobs: [
    { job_id: 1, evidence_id: 1, content_version: 1 },
    { job_id: 2, evidence_id: 1, content_version: 2 },
    { job_id: 3, evidence_id: 1, content_version: 2 },
  ] });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.upserted, 1);
  assert.equal(w.calls.filter((c) => c[0] === "embed").length, 1, "embedded once");
  assert.deepEqual([1, 2, 3].map((i) => w.jobs.get(i).status), ["done", "done", "done"]);
  assert.match(w.jobs.get(1).last_error, /^skipped: duplicate/);
});

test("stale job (older content_version than MySQL) is skipped, nothing is written", async () => {
  const w = makeWorld({ evidence: [ev(1, { content_version: 3 })], jobs: [{ job_id: 1, evidence_id: 1, content_version: 2 }] });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.skipped, 1);
  assert.equal(w.points.size, 0);
  assert.equal(w.evidence.get(1).indexed_version, null);
  assert.equal(w.jobs.get(1).status, "done");
  assert.match(w.jobs.get(1).last_error, /superseded/);
});

test("job newer than MySQL's version is a permanent inconsistency, not silently indexed", async () => {
  const w = makeWorld({ evidence: [ev(1, { content_version: 1 })], jobs: [{ job_id: 1, evidence_id: 1, content_version: 4 }] });
  await w.processor.processBatch(w.claimed());
  assert.equal(w.jobs.get(1).status, "failed");
  assert.match(w.jobs.get(1).last_error, /INDEX_VERSION_MISMATCH/);
  assert.equal(w.points.size, 0);
});

// ---- withdrawal / delete ---------------------------------------------------
test("delete job for withdrawn evidence removes the point; job done", async () => {
  const w = makeWorld({ evidence: [ev(1, { status: "withdrawn" })], jobs: [{ job_id: 1, evidence_id: 1, operation: "delete" }] });
  w.points.set(pointId("evidence", 1), { id: pointId("evidence", 1) });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.deleted, 1);
  assert.equal(w.points.size, 0);
  assert.equal(w.jobs.get(1).status, "done");
});

test("delete is idempotent: the point is already gone", async () => {
  const w = makeWorld({ evidence: [ev(1, { status: "withdrawn" })], jobs: [{ job_id: 1, evidence_id: 1, operation: "delete" }] });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.deleted, 1);
  assert.equal(w.jobs.get(1).status, "done");
});

test("an upsert job for evidence that was withdrawn meanwhile deletes instead of indexing", async () => {
  const w = makeWorld({ evidence: [ev(1, { status: "withdrawn" })], jobs: [{ job_id: 1, evidence_id: 1, operation: "upsert" }] });
  w.points.set(pointId("evidence", 1), { id: pointId("evidence", 1) });
  await w.processor.processBatch(w.claimed());
  assert.equal(w.points.size, 0);
  assert.equal(w.calls.filter((c) => c[0] === "embed").length, 0, "no embedding for withdrawn evidence");
  assert.equal(w.evidence.get(1).indexed_version, null);
});

test("a delete job for evidence that MySQL says is active is ignored (MySQL wins)", async () => {
  const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1, operation: "delete" }] });
  w.points.set(pointId("evidence", 1), { id: pointId("evidence", 1) });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.skipped, 1);
  assert.equal(w.points.size, 1);
  assert.match(w.jobs.get(1).last_error, /evidence is active/);
});

test("finding of withdrawn evidence is removed from Qdrant, not indexed", async () => {
  const w = makeWorld({ findings: [{ finding_id: 5, title: "F", description: "D", evidence_status: "withdrawn" }], jobs: [{ job_id: 1, finding_id: 5 }] });
  w.points.set(pointId("finding", 5), { id: pointId("finding", 5) });
  await w.processor.processBatch(w.claimed());
  assert.equal(w.points.size, 0);
});

test("finding delete job works without reading the finding row", async () => {
  const w = makeWorld({ jobs: [{ job_id: 1, finding_id: 5, operation: "delete" }] });
  w.points.set(pointId("finding", 5), { id: pointId("finding", 5) });
  await w.processor.processBatch(w.claimed());
  assert.equal(w.points.size, 0);
  assert.equal(w.calls.filter((c) => c[0] === "fetchFindings").length, 0);
});

// ---- permanent failures ----------------------------------------------------
test("missing source row and bad job shape fail permanently with a safe message", async () => {
  const w = makeWorld({ jobs: [{ job_id: 1, evidence_id: 99 }, { job_id: 2, evidence_id: null, finding_id: null }] });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.failed, 2);
  assert.equal(w.jobs.get(1).status, "failed");
  assert.match(w.jobs.get(1).last_error, /^\[INDEX_SOURCE_NOT_FOUND\]/);
  assert.match(w.jobs.get(2).last_error, /^\[INDEX_BAD_JOB\]/);
});

test("record with no text fails permanently", async () => {
  const w = makeWorld({ evidence: [{ evidence_id: 1, title: " ", description: "", extracted_text: null }], jobs: [{ job_id: 1, evidence_id: 1 }] });
  await w.processor.processBatch(w.claimed());
  assert.equal(w.jobs.get(1).status, "failed");
  assert.match(w.jobs.get(1).last_error, /INDEX_EMPTY_TEXT/);
});

// ---- retries ---------------------------------------------------------------
test("transient Qdrant error: job returns to pending and keeps its attempt count", async () => {
  const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1, attempts: 2 }] });
  w.failUpsert = new VectorError("QDRANT_ERROR", "The vector database could not store the vectors.", { status: 502 });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.retried, 1);
  assert.equal(w.jobs.get(1).status, "pending");
  assert.equal(w.jobs.get(1).attempts, 2);
  assert.match(w.jobs.get(1).last_error, /QDRANT_ERROR/);
  assert.equal(w.evidence.get(1).indexed_version, null, "not marked indexed after a failed write");
});

test("transient error at the attempt limit: job becomes failed", async () => {
  const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1, attempts: 5 }] });
  w.failUpsert = new VectorError("QDRANT_ERROR", "x", { status: 502 });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.failed, 1);
  assert.equal(w.jobs.get(1).status, "failed");
});

test("a failure recording indexed_version retries the job and the repeat is harmless", async () => {
  const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1 }] });
  w.failMarkIndexed = new DatabaseError("DB_CONSTRAINT", "bad", { status: 409 });
  await w.processor.processBatch(w.claimed());
  assert.equal(w.jobs.get(1).status, "pending");
  assert.equal(w.points.size, 1, "point exists");
  w.failMarkIndexed = null;
  w.jobs.get(1).status = "processing"; w.jobs.get(1).attempts = 2;
  await w.processor.processBatch(w.claimed());
  assert.equal(w.points.size, 1);
  assert.equal(w.evidence.get(1).indexed_version, 1);
  assert.equal(w.jobs.get(1).status, "done");
});

test("one poison text does not fail its neighbours (embedding fallback per item)", async () => {
  const w = makeWorld({ evidence: [ev(1), ev(2, { title: "POISON" }), ev(3)], jobs: [{ job_id: 1, evidence_id: 1 }, { job_id: 2, evidence_id: 2 }, { job_id: 3, evidence_id: 3 }] });
  w.failEmbed = (texts) => (texts.some((t) => t.includes("POISON")) ? new VectorError("EMBEDDING_FAILED", "The embedding model failed on this input.") : undefined);
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.upserted, 2);
  assert.equal(s.retried, 1);
  assert.equal(w.jobs.get(1).status, "done");
  assert.equal(w.jobs.get(2).status, "pending");
  assert.equal(w.jobs.get(3).status, "done");
});

// ---- outages ---------------------------------------------------------------
test("Qdrant outage: every job is released WITHOUT using an attempt, worker is told to back off", async () => {
  const w = makeWorld({ evidence: [ev(1), ev(2)], jobs: [{ job_id: 1, evidence_id: 1, attempts: 3 }, { job_id: 2, evidence_id: 2, attempts: 1 }] });
  w.failUpsert = new VectorError("QDRANT_UNAVAILABLE", "The vector database is not reachable right now.", { status: 503 });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.outage, true);
  assert.equal(s.upserted, 0);
  assert.deepEqual([1, 2].map((i) => w.jobs.get(i).status), ["pending", "pending"]);
  assert.deepEqual([1, 2].map((i) => w.jobs.get(i).attempts), [2, 0]);
});

test("embedding model unavailable is an outage too", async () => {
  const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1 }] });
  w.failEmbed = () => new VectorError("EMBEDDING_MODEL_UNAVAILABLE", "model", { status: 503 });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.outage, true);
  assert.equal(w.jobs.get(1).status, "pending");
});

test("MySQL outage while reading rows releases all jobs", async () => {
  const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1 }] });
  w.failFetch = new DatabaseError("DB_UNAVAILABLE", "db down", { status: 503 });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.outage, true);
  assert.equal(w.jobs.get(1).status, "pending");
});

test("if recording a result fails (MySQL down), the batch reports needsRecovery instead of throwing", async () => {
  const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1 }] });
  w.repo.markJobDone = async () => { throw new DatabaseError("DB_UNAVAILABLE", "down", { status: 503 }); };
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.needsRecovery, true);
});

// ---- corrections: read isolation, duplicates, completion order ------------------
const accessMissing = () => new IndexingError("INDEX_FINDING_ACCESS_MISSING", "The worker account cannot read analysis, so a finding's evidence and case are unknown.", { failure: FAILURE.PERMANENT });

test("finding reads refused (no SELECT on analysis): only the finding upsert fails, evidence jobs in the same batch are still indexed", async () => {
  const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1 }, { job_id: 2, finding_id: 5 }] });
  w.failFetchFindings = accessMissing();
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.upserted, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.outage, false, "not treated as a dependency outage, so no back-off loop");
  assert.equal(w.jobs.get(1).status, "done");
  assert.equal(w.jobs.get(2).status, "failed");
  assert.match(w.jobs.get(2).last_error, /^\[INDEX_FINDING_ACCESS_MISSING\]/);
  assert.ok(w.points.has(pointId("evidence", 1)));
});

test("finding delete jobs keep working while finding reads are refused", async () => {
  const w = makeWorld({ jobs: [{ job_id: 1, finding_id: 5, operation: "delete" }, { job_id: 2, finding_id: 6 }] });
  w.points.set(pointId("finding", 5), { id: pointId("finding", 5) });
  w.failFetchFindings = accessMissing();
  await w.processor.processBatch(w.claimed());
  assert.equal(w.points.size, 0);
  assert.equal(w.jobs.get(1).status, "done");
  assert.equal(w.jobs.get(2).status, "failed");
});

test("MySQL outage while reading evidence releases evidence AND finding jobs untouched (no attempt used, nothing written)", async () => {
  const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1, attempts: 2 }, { job_id: 2, finding_id: 5, attempts: 3 }] });
  w.failFetchEvidence = new DatabaseError("DB_UNAVAILABLE", "db down", { status: 503 });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.outage, true);
  assert.deepEqual([1, 2].map((i) => w.jobs.get(i).status), ["pending", "pending"]);
  assert.deepEqual([1, 2].map((i) => w.jobs.get(i).attempts), [1, 2]);
  assert.equal(w.points.size, 0);
});

test("withdrawal: the evidence delete job and the delete jobs of its findings remove all three points", async () => {
  const w = makeWorld({ evidence: [ev(1, { status: "withdrawn", content_version: 1 })], jobs: [
    { job_id: 1, evidence_id: 1, operation: "delete" },
    { job_id: 2, finding_id: 5, operation: "delete" },
    { job_id: 3, finding_id: 6, operation: "delete" },
  ] });
  for (const [k, i] of [["evidence", 1], ["finding", 5], ["finding", 6]]) w.points.set(pointId(k, i), { id: pointId(k, i) });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.deleted, 3);
  assert.equal(w.points.size, 0);
  assert.deepEqual([1, 2, 3].map((i) => w.jobs.get(i).status), ["done", "done", "done"]);
  assert.equal(w.calls.filter((c) => c[0] === "fetchFindings").length, 0, "no finding read needed to delete");
});

test("duplicates are NOT closed when the newest job of their record fails or is retried: they are handed back without using an attempt", async () => {
  const w = makeWorld({ evidence: [ev(1, { content_version: 2 })], jobs: [
    { job_id: 1, evidence_id: 1, content_version: 1, attempts: 1 },
    { job_id: 2, evidence_id: 1, content_version: 2, attempts: 1 },
  ] });
  w.failUpsert = new VectorError("QDRANT_ERROR", "x", { status: 502 });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.retried, 1);
  assert.equal(w.jobs.get(2).status, "pending");
  assert.equal(w.jobs.get(1).status, "pending", "older job is not marked done before the newest one succeeded");
  assert.equal(w.jobs.get(1).attempts, 0);
});

test("duplicates are handed back when the newest job fails permanently, and nothing is marked done", async () => {
  const w = makeWorld({ jobs: [{ job_id: 1, evidence_id: 99 }, { job_id: 2, evidence_id: 99 }] });
  await w.processor.processBatch(w.claimed());
  assert.equal(w.jobs.get(2).status, "failed");
  assert.equal(w.jobs.get(1).status, "pending");
});

test("a job is closed only after the Qdrant write AND the indexed_version update (order: upsert, markIndexed, done)", async () => {
  const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1 }] });
  const events = [];
  const { upsertPoints } = w.store; const { markIndexed, markJobDone } = w.repo;
  w.store.upsertPoints = async (p) => { events.push("upsert"); return upsertPoints(p); };
  w.repo.markIndexed = async (...a) => { events.push("markIndexed"); return markIndexed(...a); };
  w.repo.markJobDone = async (...a) => { events.push("done"); return markJobDone(...a); };
  await w.processor.processBatch(w.claimed());
  assert.deepEqual(events, ["upsert", "markIndexed", "done"]);
});

test("a failed Qdrant write or a failed indexed_version update never closes the job", async () => {
  for (const [label, arrange] of [
    ["qdrant write", (w) => { w.failUpsert = new VectorError("QDRANT_ERROR", "x", { status: 502 }); }],
    ["bookkeeping", (w) => { w.failMarkIndexed = new DatabaseError("DB_CONSTRAINT", "x", { status: 409 }); }],
  ]) {
    const w = makeWorld({ evidence: [ev(1)], jobs: [{ job_id: 1, evidence_id: 1 }] });
    arrange(w);
    await w.processor.processBatch(w.claimed());
    assert.notEqual(w.jobs.get(1).status, "done", label);
  }
});

test("summary.retryAttempts reports the highest attempt count among retried jobs (back-off hint for the runner)", async () => {
  const w = makeWorld({ evidence: [ev(1), ev(2)], jobs: [{ job_id: 1, evidence_id: 1, attempts: 2 }, { job_id: 2, evidence_id: 2, attempts: 4 }] });
  w.failUpsert = new VectorError("QDRANT_ERROR", "x", { status: 502 });
  const s = await w.processor.processBatch(w.claimed());
  assert.equal(s.retried, 2);
  assert.equal(s.retryAttempts, 4);
});

// ---- errors ---------------------------------------------------------------
test("classifyError never leaks the cause; unknown errors become a generic message", () => {
  const c = classifyError(new Error("SELECT secret FROM x WHERE password='hunter2'"));
  assert.equal(c.failure, FAILURE.TRANSIENT);
  assert.ok(!c.message.includes("hunter2"));
  const v = classifyError(new VectorError("QDRANT_ERROR", "safe", { cause: new Error("http://key@host") }));
  assert.ok(!formatLastError(v).includes("key@host"));
  assert.equal(classifyError(new VectorError("VECTOR_INVALID_INPUT", "x")).failure, FAILURE.PERMANENT);
  assert.equal(classifyError(new DatabaseError("DB_UNAVAILABLE", "x")).failure, FAILURE.OUTAGE);
  assert.equal(classifyError(new IndexingError("X", "y", { failure: FAILURE.PERMANENT })).failure, FAILURE.PERMANENT);
});

test("last_error is cut to the 500-character column limit", () => {
  assert.equal(formatLastError({ code: "C", message: "m".repeat(2000) }).length, 500);
});

// ---- config ---------------------------------------------------------------
test("config: defaults follow api-contract (10 jobs, 5 attempts) and bad values are rejected", () => {
  const c = loadWorkerConfig({});
  assert.equal(c.batchSize, 10);
  assert.equal(c.maxAttempts, 5);
  assert.equal(c.recoverOnStart, true);
  for (const env of [{ WORKER_BATCH_SIZE: "0" }, { WORKER_BATCH_SIZE: "x" }, { WORKER_MAX_ATTEMPTS: "99" }, { WORKER_RECOVER_ON_START: "maybe" }, { WORKER_BACKOFF_BASE_MS: "5000", WORKER_BACKOFF_MAX_MS: "1000" }]) {
    assert.throws(() => loadWorkerConfig(env), (e) => e.code === "INDEX_CONFIG");
  }
  assert.equal(loadWorkerConfig({ WORKER_RECOVER_ON_START: "false" }).recoverOnStart, false);
});

// ---- repository SQL ---------------------------------------------------------
function recorder(responses = []) {
  const log = [];
  const db = {
    async withSession(session, work) {
      log.push({ session });
      return work({ query: async (sql, params = []) => { log.push({ sql: sql.replace(/\s+/g, " ").trim(), params }); return responses.shift() ?? []; } });
    },
  };
  return { db, log };
}

test("repository: always the worker session (userId null); claim = list candidates, then one compare-and-set UPDATE per job", async () => {
  const { db, log } = recorder([[{ job_id: 1 }, { job_id: 2 }], { affectedRows: 1 }, { affectedRows: 1 }, [{ job_id: 1 }, { job_id: 2 }]]);
  const repo = createIndexRepository({ db });
  const jobs = await repo.claimPending(10);
  assert.deepEqual(jobs, [{ job_id: 1 }, { job_id: 2 }]);
  assert.deepEqual(log[0].session, { role: "worker", userId: null });
  assert.equal(WORKER_SESSION.role, "worker");
  const sqls = log.filter((l) => l.sql);
  assert.match(sqls[0].sql, /^SELECT job_id FROM index_job WHERE status = 'pending' ORDER BY job_id LIMIT 10$/);
  assert.match(sqls[1].sql, /^UPDATE index_job SET status = 'processing', attempts = attempts \+ 1 WHERE job_id = \? AND status = 'pending'$/);
  assert.deepEqual(sqls[1].params, [1]);
  assert.deepEqual(sqls[2].params, [2]);
  assert.match(sqls[3].sql, /WHERE job_id IN \(\?, \?\) AND status = 'processing' ORDER BY job_id$/);
  assert.deepEqual(sqls[3].params, [1, 2]);
  await assert.rejects(() => repo.claimPending("10; DROP TABLE evidence"), TypeError);
  await assert.rejects(() => repo.claimPending(0), TypeError);
});

test("repository claim: returns only the rows THIS call changed (lost compare-and-set is dropped)", async () => {
  // job 2 was taken by somebody else between the candidate SELECT and our UPDATE
  const { db, log } = recorder([[{ job_id: "1" }, { job_id: "2" }, { job_id: "3" }], { affectedRows: 1 }, { affectedRows: 0 }, { affectedRows: 1 }, [{ job_id: 1 }, { job_id: 3 }]]);
  const jobs = await createIndexRepository({ db }).claimPending(5);
  assert.deepEqual(jobs.map((j) => j.job_id), [1, 3]);
  const readBack = log.filter((l) => l.sql).at(-1);
  assert.deepEqual(readBack.params, [1, 3], "job 2 is not read back or processed");
});

test("repository claim: if the db layer does not report affectedRows, claiming fails loudly instead of silently claiming nothing", async () => {
  const { db } = recorder([[{ job_id: 1 }], undefined]); // UPDATE result without affectedRows
  const repo = createIndexRepository({ db: { withSession: (s, work) => db.withSession(s, (q) => work({ query: async (sql, p) => { const r = await q.query(sql, p); return /^UPDATE/.test(sql) ? [] : r; } })) } });
  await assert.rejects(() => repo.claimPending(5), (e) => e instanceof IndexingError && e.code === "INDEX_DB_RESULT");
});

test("repository claim: an empty queue needs no further SQL, and the old whole-table read-back of 'processing' rows is gone", async () => {
  const empty = recorder([[]]);
  assert.deepEqual(await createIndexRepository({ db: empty.db }).claimPending(10), []);
  assert.equal(empty.log.filter((l) => l.sql).length, 1);

  const one = recorder([[{ job_id: 1 }], { affectedRows: 1 }, [{ job_id: 1 }]]);
  await createIndexRepository({ db: one.db }).claimPending(1);
  const selects = one.log.filter((l) => l.sql?.startsWith("SELECT"));
  assert.ok(selects.every((l) => !/WHERE status = 'processing'(?! ORDER)/.test(l.sql) || /job_id IN/.test(l.sql)), "read-back is limited to the claimed job ids");
});

test("repository: IDs are bound parameters; non-numeric IDs are refused before any SQL", async () => {
  const { db, log } = recorder([[{ evidence_id: 1 }]]);
  const repo = createIndexRepository({ db });
  const rows = await repo.fetchEvidence([1, 2]);
  assert.ok(rows.has(1));
  const q = log.find((l) => l.sql?.startsWith("SELECT"));
  assert.match(q.sql, /WHERE evidence_id IN \(\?, \?\)/);
  assert.deepEqual(q.params, [1, 2]);
  const before = log.length;
  await assert.rejects(() => repo.fetchEvidence(["1 OR 1=1"]), TypeError);
  await assert.rejects(() => repo.fetchFindings([]), TypeError);
  assert.equal(log.length, before);
});

test("repository: updates are guarded (indexed_version never moves backwards, job status checked)", async () => {
  const { db, log } = recorder();
  const repo = createIndexRepository({ db });
  await repo.markIndexed("evidence", 7, 3);
  await repo.markIndexed("finding", 8, 2);
  await repo.markJobDone(5, "why");
  await repo.releaseJob(5, "e", { countAttempt: false });
  await repo.markJobFailed(5, "e".repeat(900));
  const sqls = log.filter((l) => l.sql);
  assert.match(sqls[0].sql, /UPDATE evidence SET indexed_version = \?, indexed_at = NOW\(\) WHERE evidence_id = \? AND \(indexed_version IS NULL OR indexed_version <= \?\)/);
  assert.deepEqual(sqls[0].params, [3, 7, 3]);
  assert.match(sqls[1].sql, /UPDATE finding SET indexed_version/);
  assert.deepEqual(sqls[2].params, ["skipped: why", 5]);
  assert.match(sqls[2].sql, /AND status = 'processing'/);
  assert.deepEqual(sqls[3].params, ["e", 0, 5]);
  assert.equal(sqls[4].params[0].length, 500);
  await assert.rejects(() => repo.markIndexed("case", 1, 1), TypeError);
});

test("repository: crash recovery fails jobs at the attempt limit, requeues the rest", async () => {
  const { db, log } = recorder([{ affectedRows: 1 }, { affectedRows: 4 }]);
  const res = await createIndexRepository({ db }).recoverInterrupted(5);
  assert.deepEqual(res, { requeued: 4, failed: 1 });
  const sqls = log.filter((l) => l.sql);
  assert.match(sqls[0].sql, /SET status = 'failed'.*WHERE status = 'processing' AND attempts >= \?/);
  assert.deepEqual(sqls[0].params[1], 5);
  assert.match(sqls[1].sql, /SET status = 'pending' WHERE status = 'processing'/);
});

test("repository SQL touches only tables the worker is meant to use, and never a stored procedure", async () => {
  const { db, log } = recorder([[], [], [], [], [], {}, {}]);
  const repo = createIndexRepository({ db });
  await repo.recoverInterrupted(5); await repo.claimPending(3); await repo.fetchEvidence([1]); await repo.fetchFindings([1]);
  await repo.markIndexed("evidence", 1, 1); await repo.markIndexed("finding", 1, 1); await repo.markJobDone(1); await repo.releaseJob(1, "x"); await repo.markJobFailed(1, "x");
  const text = log.filter((l) => l.sql).map((l) => l.sql).join(" ");
  const tables = new Set([...text.matchAll(/\b(?:FROM|JOIN|UPDATE)\s+([a-z_]+)/gi)].map((m) => m[1]));
  assert.deepEqual([...tables].sort(), ["analysis", "evidence", "finding", "index_job"]);
  assert.ok(!/\bCALL\b/i.test(text), "no stored procedure is used");
});

test("repository: indexed_version bookkeeping sets ONLY indexed_version and indexed_at (no content change, so no version bump and no new job)", async () => {
  const { db, log } = recorder();
  const repo = createIndexRepository({ db });
  await repo.markIndexed("evidence", 7, 3);
  await repo.markIndexed("finding", 8, 3);
  for (const l of log.filter((x) => x.sql)) {
    const setPart = l.sql.match(/ SET (.*?) WHERE /)[1];
    const cols = setPart.split(",").map((c) => c.split("=")[0].trim()).sort();
    assert.deepEqual(cols, ["indexed_at", "indexed_version"], l.sql);
    assert.ok(!/content_version|title|description|extracted_text|status/.test(setPart));
  }
});

test("repository.fetchFindings: a missing privilege on analysis becomes a PERMANENT, job-level failure; other errors pass through", async () => {
  const denied = new DatabaseError("DB_PERMISSION_DENIED", "denied", { status: 403 });
  const repoDenied = createIndexRepository({ db: { withSession: async () => { throw denied; } } });
  await assert.rejects(() => repoDenied.fetchFindings([1]), (e) => e instanceof IndexingError && e.code === "INDEX_FINDING_ACCESS_MISSING" && e.failure === FAILURE.PERMANENT);
  const down = new DatabaseError("DB_UNAVAILABLE", "down", { status: 503 });
  const repoDown = createIndexRepository({ db: { withSession: async () => { throw down; } } });
  await assert.rejects(() => repoDown.fetchFindings([1]), (e) => e === down);
});

test("repository.canResolveFindings: false on a privilege error, true when readable, other errors propagate", async () => {
  const mk = (fn) => createIndexRepository({ db: { withSession: fn } });
  assert.equal(await mk(async (_s, work) => work({ query: async () => [] })).canResolveFindings(), true);
  assert.equal(await mk(async () => { throw new DatabaseError("DB_PERMISSION_DENIED", "x"); }).canResolveFindings(), false);
  await assert.rejects(() => mk(async () => { throw new DatabaseError("DB_UNAVAILABLE", "x"); }).canResolveFindings());
});

// ---- runner -----------------------------------------------------------------
test("runner: recovers once at start, drains, and backs off exponentially during an outage", async () => {
  const calls = [];
  const sleeps = [];
  let n = 0;
  const repo = {
    async recoverInterrupted() { calls.push("recover"); return { requeued: 0, failed: 0 }; },
    async claimPending() { calls.push("claim"); return [{ job_id: ++n }]; },
  };
  const outcomes = [{ outage: true }, { outage: true }, { outage: true }, { outage: false, claimed: 0 }];
  const processor = { async processBatch() { const o = outcomes.shift(); return { claimed: 1, upserted: 0, deleted: 0, skipped: 0, retried: 0, failed: 0, needsRecovery: false, ...o }; } };
  let worker;
  worker = createWorker({ repo, processor, config: CONFIG, logger: silent, sleep: async (ms) => { sleeps.push(ms); if (outcomes.length === 0) worker.stop(); } });
  await worker.start();
  assert.deepEqual(sleeps.slice(0, 3), [100, 200, 400], "exponential back-off");
  assert.equal(calls.filter((c) => c === "recover").length, 4, "recovery at start and after each outage");
});

test("runner: a failing claim (MySQL down) backs off instead of crashing", async () => {
  let worker; const sleeps = [];
  const repo = { async recoverInterrupted() { throw new DatabaseError("DB_UNAVAILABLE", "x", { status: 503 }); }, async claimPending() { return []; } };
  worker = createWorker({ repo, processor: { processBatch: async () => ({}) }, config: CONFIG, logger: silent, sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 2) worker.stop(); } });
  await worker.start();
  assert.deepEqual(sleeps, [100, 200]);
});

test("runner.drain: processes until the queue is empty", async () => {
  let queue = [[{ job_id: 1 }], [{ job_id: 2 }], []];
  const repo = { async recoverInterrupted() { return { requeued: 0, failed: 0 }; }, async claimPending() { return queue.shift() ?? []; } };
  const processor = { async processBatch(jobs) { return { claimed: jobs.length, upserted: jobs.length, deleted: 0, skipped: 0, retried: 0, failed: 0, outage: false, needsRecovery: false }; } };
  const worker = createWorker({ repo, processor, config: CONFIG, logger: silent });
  const total = await worker.drain();
  assert.equal(total.claimed, 2);
  assert.equal(total.upserted, 2);
});

test("runner: after a batch that retried jobs it waits base * 2^(attempts-1) (capped) before claiming again", async () => {
  const sleeps = [];
  let worker; let n = 0;
  // bounded: a regression must make the assertion below fail, not loop forever
  const repo = { async recoverInterrupted() { return { requeued: 0, failed: 0 }; }, async claimPending() { if (n >= 6) worker.stop(); return [{ job_id: ++n }]; } };
  const outcomes = [{ retried: 1, retryAttempts: 1 }, { retried: 1, retryAttempts: 3 }, { retried: 1, retryAttempts: 9 }];
  const processor = { async processBatch() { const o = outcomes.shift(); return { claimed: 1, upserted: 0, deleted: 0, skipped: 0, failed: 0, outage: false, needsRecovery: false, retried: 0, retryAttempts: 0, ...o }; } };
  worker = createWorker({ repo, processor, config: CONFIG, logger: silent, sleep: async (ms) => { sleeps.push(ms); if (outcomes.length === 0) worker.stop(); } });
  await worker.start();
  assert.deepEqual(sleeps.slice(0, 3), [100, 400, 800], "100 * 2^0, 100 * 2^2, capped at backoffMaxMs");
});

test("runner.drain: also waits after retries, so one failing job cannot burn all its attempts in a burst", async () => {
  const sleeps = [];
  const queue = [[{ job_id: 1 }], []];
  const repo = { async recoverInterrupted() { return { requeued: 0, failed: 0 }; }, async claimPending() { return queue.shift() ?? []; } };
  const processor = { async processBatch(jobs) { return { claimed: jobs.length, upserted: 0, deleted: 0, skipped: 0, retried: jobs.length, retryAttempts: 2, failed: 0, outage: false, needsRecovery: false }; } };
  const worker = createWorker({ repo, processor, config: CONFIG, logger: silent, sleep: async (ms) => { sleeps.push(ms); } });
  const total = await worker.drain();
  assert.equal(total.retried, 1);
  assert.deepEqual(sleeps, [200]);
});

test("runner: a batch whose results could not be recorded triggers crash recovery before the next claim", async () => {
  const calls = []; let worker; let n = 0;
  const repo = { async recoverInterrupted() { calls.push("recover"); return { requeued: 1, failed: 0 }; }, async claimPending() { calls.push("claim"); return n++ < 2 ? [{ job_id: n }] : []; } };
  const outcomes = [{ needsRecovery: true }, { needsRecovery: false }];
  const processor = { async processBatch(jobs) { const o = outcomes.shift() ?? {}; return { claimed: jobs.length, upserted: 0, deleted: 0, skipped: 0, retried: 0, failed: 0, outage: false, needsRecovery: false, ...o }; } };
  worker = createWorker({ repo, processor, config: CONFIG, logger: silent, sleep: async () => { if (calls.filter((c) => c === "claim").length >= 3) worker.stop(); } });
  await worker.start();
  assert.deepEqual(calls.slice(0, 4), ["recover", "claim", "recover", "claim"]);
});

test("runner: with WORKER_RECOVER_ON_START=false there is no recovery at start", async () => {
  const calls = []; let worker;
  const repo = { async recoverInterrupted() { calls.push("recover"); return { requeued: 0, failed: 0 }; }, async claimPending() { calls.push("claim"); return []; } };
  worker = createWorker({ repo, processor: { processBatch: async () => ({ claimed: 0 }) }, config: { ...CONFIG, recoverOnStart: false }, logger: silent, sleep: async () => worker.stop() });
  await worker.start();
  assert.deepEqual(calls, ["claim"]);
});
