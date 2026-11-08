// Live checks for the indexing worker. Two independent parts; each is SKIPPED (not passed)
// when its service or settings are missing.
//
//   cd app && npm run test:indexing:live        (reads .env.local)
//
// Part 1  needs a running Qdrant (QDRANT_URL). Uses a throwaway collection tracex_test_<random>
//         that is deleted afterwards; never touches tracex_records. The repository and the
//         embedder are fakes, so this tests the processor against REAL Qdrant behaviour
//         (point IDs, overwrite, delete, payload shape), not MySQL or the model.
//
// Part 2  needs MySQL with Person A's schema and the DB_* variables (worker account).
//         It checks the SQL CONTRACT the worker depends on, with statements that read or
//         change NOTHING (SELECT ... WHERE 1 = 0, UPDATE ... WHERE 1 = 0): the tables, the
//         columns, and the worker account's privileges. A failure here names exactly what
//         the real SQL does not provide.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadVectorConfig } from "../../src/lib/vector/config.js";
import { createVectorStore } from "../../src/lib/vector/qdrant.js";
import { pointId, parsePayload } from "../../src/lib/vector/ids.js";
import { createProcessor } from "../../src/lib/indexing/processor.js";
import { WORKER_SESSION } from "../../src/lib/indexing/repository.js";

const CONFIG = { batchSize: 10, maxAttempts: 5 };
const silent = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// Part 1: processor + real Qdrant
// ---------------------------------------------------------------------------
const qdrantUrl = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
const collection = `tracex_test_${randomBytes(4).toString("hex")}`;
const vconfig = loadVectorConfig({ ...process.env, QDRANT_URL: qdrantUrl, QDRANT_COLLECTION: collection });
const store = createVectorStore({ config: vconfig });

let qdrantUp = true;
try {
  await store.ping();
} catch {
  qdrantUp = false;
}
const skipQdrant = qdrantUp ? false : `Qdrant is not reachable at ${vconfig.qdrantUrl} (docker run -d -p 6333:6333 qdrant/qdrant)`;

after(async () => {
  if (qdrantUp) {
    try { await store.client.deleteCollection(collection); } catch { /* already gone */ }
  }
});

function axis(i) { const v = new Array(384).fill(0); v[i] = 1; return v; }

function fakeWorld() {
  const w = {
    evidence: new Map([[1, { evidence_id: 1, case_id: 7, title: "USB image", description: "Disk image from the laptop", extracted_text: null, status: "active", content_version: 1 }]]),
    jobs: new Map(),
    indexed: new Map(),
  };
  w.repo = {
    async fetchEvidence(ids) { return new Map(ids.filter((i) => w.evidence.has(i)).map((i) => [i, w.evidence.get(i)])); },
    async fetchFindings() { return new Map(); },
    async markIndexed(kind, id, v) { w.indexed.set(`${kind}:${id}`, v); },
    async markJobDone(id) { w.jobs.set(id, "done"); },
    async releaseJob(id) { w.jobs.set(id, "pending"); },
    async markJobFailed(id) { w.jobs.set(id, "failed"); },
  };
  w.embedder = { async embedDocuments(texts) { return texts.map((_, i) => axis(i)); } };
  w.processor = createProcessor({ repo: w.repo, embedder: w.embedder, store, config: CONFIG, logger: silent });
  return w;
}

test("Qdrant: collection is created for the test", { skip: skipQdrant }, async () => {
  await store.ensureCollection();
  assert.equal(await store.countPoints(), 0);
});

test("Qdrant: upsert job writes one point with the convention ID and a text-free payload", { skip: skipQdrant }, async () => {
  const w = fakeWorld();
  const s = await w.processor.processBatch([{ job_id: 1, evidence_id: 1, finding_id: null, operation: "upsert", content_version: 1, attempts: 1 }]);
  assert.equal(s.upserted, 1);
  assert.equal(await store.countPoints(), 1);
  const point = await store.retrievePoint(pointId("evidence", 1));
  assert.ok(point, "point exists under the UUIDv5 ID");
  assert.deepEqual(point.payload, { kind: "evidence", record_id: 1, evidence_id: 1, case_id: 7, content_version: 1 });
  assert.ok(parsePayload(point.payload));
  assert.ok(!JSON.stringify(point.payload).includes("USB"), "no text stored in Qdrant");
});

test("Qdrant: the same job twice, and a newer version, overwrite the same single point", { skip: skipQdrant }, async () => {
  const w = fakeWorld();
  const job = { job_id: 2, evidence_id: 1, finding_id: null, operation: "upsert", content_version: 1, attempts: 1 };
  await w.processor.processBatch([job]);
  await w.processor.processBatch([{ ...job, job_id: 3 }]);
  assert.equal(await store.countPoints(), 1);

  w.evidence.get(1).content_version = 2;
  await w.processor.processBatch([{ ...job, job_id: 4, content_version: 2 }]);
  assert.equal(await store.countPoints(), 1);
  const point = await store.retrievePoint(pointId("evidence", 1));
  assert.equal(point.payload.content_version, 2);
  assert.equal(w.indexed.get("evidence:1"), 2);
});

test("Qdrant: withdrawal removes the point; repeating the delete is harmless", { skip: skipQdrant }, async () => {
  const w = fakeWorld();
  w.evidence.get(1).status = "withdrawn";
  const del = { job_id: 5, evidence_id: 1, finding_id: null, operation: "delete", content_version: 2, attempts: 1 };
  const s = await w.processor.processBatch([del]);
  assert.equal(s.deleted, 1);
  assert.equal(await store.retrievePoint(pointId("evidence", 1)), null);
  assert.equal(await store.countPoints(), 0);
  const again = await w.processor.processBatch([{ ...del, job_id: 6 }]);
  assert.equal(again.deleted, 1);
  assert.equal(w.jobs.get(6), "done");
});

test("Qdrant: stale job (older version) leaves the index untouched", { skip: skipQdrant }, async () => {
  const w = fakeWorld();
  w.evidence.get(1).content_version = 3;
  const s = await w.processor.processBatch([{ job_id: 7, evidence_id: 1, finding_id: null, operation: "upsert", content_version: 2, attempts: 1 }]);
  assert.equal(s.skipped, 1);
  assert.equal(await store.countPoints(), 0);
});

// ---------------------------------------------------------------------------
// Part 2: the MySQL contract, checked with statements that change nothing
// ---------------------------------------------------------------------------
const DB_VARS = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_ADMIN_USER", "DB_ADMIN_PASSWORD", "DB_INVESTIGATOR_USER", "DB_INVESTIGATOR_PASSWORD", "DB_WORKER_USER", "DB_WORKER_PASSWORD"];
const missingDb = DB_VARS.filter((n) => !process.env[n]);
const skipDb = missingDb.length ? `missing in .env.local: ${missingDb.join(", ")}` : false;

let dbLayer = null;
if (!skipDb) dbLayer = await import("../../src/lib/db/index.js");
after(async () => { if (dbLayer) await dbLayer.closeAll(); });

// Each probe: [description, SQL]. WHERE 1 = 0 means no row is read or changed, but MySQL still
// checks that the table and columns exist and that the worker account holds the privilege.
const PROBES = [
  ["worker can SELECT index_job columns", "SELECT job_id, evidence_id, finding_id, operation, content_version, status, attempts, last_error, created_at, processed_at FROM index_job WHERE 1 = 0"],
  ["worker can UPDATE index_job status/attempts/last_error/processed_at", "UPDATE index_job SET status = 'pending', attempts = attempts, last_error = NULL, processed_at = NULL WHERE 1 = 0"],
  ["worker can SELECT evidence text, case and status", "SELECT evidence_id, case_id, title, description, extracted_text, status, content_version, indexed_version FROM evidence WHERE 1 = 0"],
  ["worker can UPDATE evidence.indexed_version / indexed_at", "UPDATE evidence SET indexed_version = 1, indexed_at = NOW() WHERE 1 = 0"],
  ["worker can SELECT finding columns", "SELECT finding_id, analysis_id, title, description, content_version, indexed_version FROM finding WHERE 1 = 0"],
  ["worker can UPDATE finding.indexed_version / indexed_at", "UPDATE finding SET indexed_version = 1, indexed_at = NOW() WHERE 1 = 0"],
];

for (const [name, sql] of PROBES) {
  test(`MySQL contract: ${name}`, { skip: skipDb }, async () => {
    await dbLayer.query(WORKER_SESSION, sql);
  });
}

// KNOWN GAP (see worker/README.md B1). `todo`: reported but does not fail the run. Remove the
// option once Person A has granted SELECT on analysis.
test("MySQL contract: worker can SELECT analysis (finding -> evidence -> case)", {
  skip: skipDb,
  todo: "02_access.sql gives tracex_worker no privilege on analysis; finding upserts cannot resolve evidence_id/case_id.",
}, async () => {
  await dbLayer.query(WORKER_SESSION, "SELECT analysis_id, evidence_id FROM analysis WHERE 1 = 0");
});

const DENIED = (e) => e.code === "DB_PERMISSION_DENIED" || e.code === "DB_ACCESS_DENIED";

test("MySQL contract: least privilege matches 02_access.sql (no other tables, no DELETE, no content columns)", { skip: skipDb }, async () => {
  for (const sql of [
    "SELECT * FROM case_assignment WHERE 1 = 0",
    "SELECT * FROM app_user WHERE 1 = 0",
    "DELETE FROM audit_log WHERE 1 = 0",
    "DELETE FROM evidence WHERE 1 = 0",
    "DELETE FROM index_job WHERE 1 = 0",
    // column-level grant: only indexed_version / indexed_at may be updated
    "UPDATE evidence SET title = title WHERE 1 = 0",
    "UPDATE evidence SET content_version = content_version WHERE 1 = 0",
    "UPDATE finding SET description = description WHERE 1 = 0",
    "UPDATE finding SET content_version = content_version WHERE 1 = 0",
  ]) {
    await assert.rejects(() => dbLayer.query(WORKER_SESSION, sql), DENIED, sql);
  }
});
