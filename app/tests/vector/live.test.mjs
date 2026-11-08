// Live test against a REAL Qdrant server. It uses a throwaway collection
// (tracex_test_<random>) that is deleted afterwards; it never touches tracex_records.
// It uses fixed fake vectors, so it tests Qdrant behaviour, not the embedding model.
//
//   cd app && npm run test:vector:live
//
// REQUIRES a running Qdrant at QDRANT_URL. Exits with a clear message if there is none.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadVectorConfig } from "../../src/lib/vector/config.js";
import { createVectorStore } from "../../src/lib/vector/qdrant.js";
import { checkVectorHealth } from "../../src/lib/vector/health.js";
import { pointId, buildPayload, parsePayload } from "../../src/lib/vector/ids.js";

const url = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
const collection = `tracex_test_${randomBytes(4).toString("hex")}`;
const config = loadVectorConfig({ ...process.env, QDRANT_URL: url, QDRANT_COLLECTION: collection });
const store = createVectorStore({ config });

// A unit vector pointing mostly along one axis; lets us predict cosine ranking.
function axisVector(axis, tilt = 0, tiltAxis = 1) {
  const v = new Array(384).fill(0);
  v[axis] = 1;
  v[tiltAxis] = tilt;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

// This suite REQUIRES a running Qdrant. If it is not reachable, stop at once with one
// clear message instead of failing every test with the same vague error.
try {
  await store.ping();
} catch {
  console.error(
    `\nQdrant is not reachable at ${config.qdrantUrl}.\n` +
      "The live tests need a running Qdrant. Start one, then run this again:\n" +
      "  docker run -d -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant\n" +
      "(The unit tests, `npm run test:vector`, need no Qdrant.)\n",
  );
  process.exit(1);
}

after(async () => {
  try {
    await store.client.deleteCollection(collection);
  } catch {
    /* already gone */
  }
});

test("ensureCollection creates it with 384/Cosine and payload indexes, then is idempotent", async () => {
  const first = await store.ensureCollection();
  assert.equal(first.created, true);
  assert.deepEqual(first.createdIndexes, ["case_id", "kind"]);

  const state = await store.inspectCollection();
  assert.equal(state.exists, true);
  assert.deepEqual(state.problems, []);
  assert.equal(state.indexes.case_id, "integer");
  assert.equal(state.indexes.kind, "keyword");

  const second = await store.ensureCollection();
  assert.equal(second.created, false);
  assert.deepEqual(second.createdIndexes, []);
});

test("upsert, cosine ranking, case filter, kind filter", async () => {
  const pts = [
    { kind: "evidence", id: 1, caseId: 10, vector: axisVector(0, 0.0) },
    { kind: "evidence", id: 2, caseId: 10, vector: axisVector(0, 0.5) },
    { kind: "evidence", id: 3, caseId: 20, vector: axisVector(0, 0.1) },
    { kind: "finding", id: 4, caseId: 10, vector: axisVector(0, 0.2) },
    { kind: "evidence", id: 5, caseId: 10, vector: axisVector(7) }, // unrelated
  ];
  await store.upsertPoints(
    pts.map((p) => ({
      id: pointId(p.kind, p.id),
      vector: p.vector,
      payload: buildPayload({ kind: p.kind, recordId: p.id, caseId: p.caseId, contentVersion: 1 }),
    })),
  );
  assert.equal(await store.countPoints(), 5);

  const q = axisVector(0);
  const all = await store.search({ vector: q, limit: 10 });
  assert.equal(all.length, 5);
  assert.equal(all[0].id, pointId("evidence", 1));
  assert.ok(Math.abs(all[0].score - 1) < 1e-4, `score ${all[0].score}`);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].score >= all[i].score);
  assert.deepEqual(parsePayload(all[0].payload), {
    kind: "evidence", recordId: 1, evidenceId: 1, caseId: 10, contentVersion: 1,
  });

  const case10 = await store.search({ vector: q, caseIds: [10], limit: 10 });
  assert.deepEqual(new Set(case10.map((h) => parsePayload(h.payload).caseId)), new Set([10]));
  assert.equal(case10.length, 4);

  const case20 = await store.search({ vector: q, caseIds: [20], limit: 10 });
  assert.equal(case20.length, 1);
  assert.equal(case20[0].id, pointId("evidence", 3));

  const findingsOnly = await store.search({ vector: q, kind: "finding", limit: 10 });
  assert.equal(findingsOnly.length, 1);
  assert.equal(findingsOnly[0].id, pointId("finding", 4));

  assert.deepEqual(await store.search({ vector: q, caseIds: [] }), []);
  assert.deepEqual(await store.search({ vector: q, caseIds: [999] }), []);
});

test("upserting the same record overwrites the same point (no duplicates)", async () => {
  const id = pointId("evidence", 1);
  await store.upsertPoints([
    { id, vector: axisVector(3), payload: buildPayload({ kind: "evidence", recordId: 1, caseId: 10, contentVersion: 2 }) },
  ]);
  assert.equal(await store.countPoints(), 5);
  const point = await store.retrievePoint(id);
  assert.equal(parsePayload(point.payload).contentVersion, 2);
  assert.equal(await store.retrievePoint(pointId("evidence", 12345)), null);
});

test("payload holds no text, only the agreed keys", async () => {
  const point = await store.retrievePoint(pointId("finding", 4));
  assert.deepEqual(Object.keys(point.payload).sort(), ["case_id", "content_version", "evidence_id", "kind", "record_id"]);
});

test("delete removes the point, and deleting a missing point is not an error", async () => {
  const id = pointId("evidence", 2);
  await store.deletePoints([id]);
  assert.equal(await store.retrievePoint(id), null);
  assert.equal(await store.countPoints(), 4);
  await store.deletePoints([id]); // second time: no error
  await store.deletePoints([pointId("evidence", 99999)]);
  assert.equal(await store.countPoints(), 4);
});

test("health is ok for a correct collection and reports the point count", async () => {
  const report = await checkVectorHealth({ store, embedder: null });
  assert.equal(report.ok, true);
  assert.equal(report.collection.points, 4);
});

test("a collection with the wrong size is reported and left untouched", async () => {
  const wrong = `${collection}_wrong`;
  await store.client.createCollection(wrong, { vectors: { size: 8, distance: "Dot" } });
  try {
    const wrongStore = createVectorStore({ config: { ...config, collection: wrong } });
    await assert.rejects(wrongStore.ensureCollection(), (e) => e.code === "QDRANT_COLLECTION_MISMATCH");
    const info = await store.client.getCollection(wrong);
    assert.equal(info.config.params.vectors.size, 8); // not recreated
    const report = await checkVectorHealth({ store: wrongStore, embedder: null });
    assert.equal(report.ok, false);
  } finally {
    await store.client.deleteCollection(wrong);
  }
});

test("a missing collection is reported by health, not created by it", async () => {
  const missingStore = createVectorStore({ config: { ...config, collection: `${collection}_none` } });
  const report = await checkVectorHealth({ store: missingStore, embedder: null });
  assert.equal(report.ok, false);
  assert.match(report.collection.message, /does not exist/);
  assert.equal((await missingStore.inspectCollection()).exists, false);
});
