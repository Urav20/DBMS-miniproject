// Unit tests for the vector layer. No Qdrant server and no model download needed:
// the Qdrant client and the embedding pipeline are replaced by fakes.
//   npm run test:vector

import test from "node:test";
import assert from "node:assert/strict";
import { loadVectorConfig } from "../../src/lib/vector/config.js";
import { pointId, buildPayload, parsePayload, uuidv5 } from "../../src/lib/vector/ids.js";
import { buildEvidenceText, buildFindingText, QUERY_PREFIX } from "../../src/lib/vector/text.js";
import { createEmbedder, enforceMaxTokens } from "../../src/lib/vector/embedding.js";
import { FeatureExtractionPipeline, Tensor } from "@huggingface/transformers";
import { createVectorStore } from "../../src/lib/vector/qdrant.js";
import { checkVectorHealth } from "../../src/lib/vector/health.js";
import { VectorError, toQdrantError } from "../../src/lib/vector/errors.js";

const ENV = { QDRANT_URL: "http://127.0.0.1:6333" };

// ---- config ---------------------------------------------------------------
test("config: defaults match the design", () => {
  const c = loadVectorConfig(ENV);
  assert.equal(c.qdrantUrl, "http://127.0.0.1:6333");
  assert.equal(c.collection, "tracex_records");
  assert.equal(c.embedding.model, "BAAI/bge-small-en-v1.5");
  assert.equal(c.embedding.dimensions, 384);
  assert.equal(c.embedding.pooling, "cls");
  assert.equal(c.qdrantApiKey, undefined);
});

test("config: bad values are rejected without printing secrets", () => {
  const bad = [
    {},
    { QDRANT_URL: "not a url" },
    { QDRANT_URL: "ftp://x" },
    { QDRANT_URL: "http://user:secretpw@host:6333" },
    { ...ENV, QDRANT_COLLECTION: "bad name!" },
    { ...ENV, EMBEDDING_MODEL: "some/other-model" },
    { ...ENV, QDRANT_TIMEOUT_MS: "0" },
  ];
  for (const env of bad) {
    assert.throws(() => loadVectorConfig(env), (e) => {
      assert.ok(e instanceof VectorError);
      assert.equal(e.code, "VECTOR_CONFIG");
      assert.ok(!e.message.includes("secretpw"));
      return true;
    });
  }
  assert.throws(() => loadVectorConfig({ ...ENV, QDRANT_API_KEY: "k", QDRANT_TIMEOUT_MS: "x" }), (e) => !e.message.includes('"k"'));
});

// ---- ids / payload --------------------------------------------------------
test("uuidv5 matches the RFC 4122 reference value", () => {
  // Well-known example: uuid5(NAMESPACE_DNS, "python.org")
  assert.equal(
    uuidv5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
    "886313e1-3b8a-5372-9b90-0c9aee199e5d",
  );
});

test("pointId is deterministic, valid UUIDv5, and distinct per kind and id", () => {
  const a = pointId("evidence", 7);
  assert.equal(a, pointId("evidence", 7));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, pointId("finding", 7));
  assert.notEqual(a, pointId("evidence", 8));
});

test("pointId rejects bad input", () => {
  for (const [k, id] of [["case", 1], ["evidence", 0], ["evidence", 1.5], ["evidence", "7"], ["evidence", -1]]) {
    assert.throws(() => pointId(k, id), (e) => e.code === "VECTOR_INVALID_INPUT");
  }
});

test("payload has exactly the agreed keys and no text", () => {
  const p = buildPayload({ kind: "evidence", recordId: 5, caseId: 2, contentVersion: 3 });
  assert.deepEqual(Object.keys(p).sort(), ["case_id", "content_version", "evidence_id", "kind", "record_id"]);
  assert.deepEqual(p, { kind: "evidence", record_id: 5, evidence_id: 5, case_id: 2, content_version: 3 });
  const f = buildPayload({ kind: "finding", recordId: 9, contentVersion: 1 });
  assert.equal(f.evidence_id, null);
  assert.equal(f.case_id, null);
  assert.throws(() => buildPayload({ kind: "evidence", recordId: 5, evidenceId: 6, contentVersion: 1 }));
  assert.throws(() => buildPayload({ kind: "evidence", recordId: 5, contentVersion: 0 }));
});

test("parsePayload ignores foreign or damaged payloads", () => {
  assert.equal(parsePayload(null), null);
  assert.equal(parsePayload({ kind: "case", record_id: 1, content_version: 1 }), null);
  assert.equal(parsePayload({ kind: "evidence", record_id: "1", content_version: 1 }), null);
  assert.deepEqual(
    parsePayload({ kind: "finding", record_id: 4, evidence_id: 2, case_id: 1, content_version: 2 }),
    { kind: "finding", recordId: 4, evidenceId: 2, caseId: 1, contentVersion: 2 },
  );
});

// ---- text -----------------------------------------------------------------
test("embedded text: evidence = title+description+extracted_text, finding = title+description", () => {
  assert.equal(buildEvidenceText({ title: "T", description: "D", extracted_text: "X" }), "T\n\nD\n\nX");
  assert.equal(buildEvidenceText({ title: "T", description: "D", extracted_text: null }), "T\n\nD");
  assert.equal(buildFindingText({ title: " T ", description: "D", severity: "high" }), "T\n\nD");
});

// ---- embedder (fake model) ------------------------------------------------
function fakePipelineLoader(calls = { loads: 0, inputs: [] }, { dims = 384, failLoads = 0 } = {}) {
  let failures = failLoads;
  return {
    calls,
    load: async () => {
      calls.loads += 1;
      if (failures-- > 0) throw new Error("download failed");
      return async (batch, opts) => {
        calls.inputs.push({ batch, opts });
        return {
          tolist: () =>
            batch.map((t, i) => Array.from({ length: dims }, (_, d) => ((t.length + i + d) % 7) + 1)),
        };
      };
    },
  };
}

test("embedder: 384 unit-length vectors, CLS pooling requested, documents get no prefix", async () => {
  const f = fakePipelineLoader();
  const e = createEmbedder({ config: loadVectorConfig(ENV), loadPipeline: f.load });
  const [v] = await e.embedDocuments(["a log line"]);
  assert.equal(v.length, 384);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
  assert.equal(f.calls.inputs[0].batch[0], "a log line");
  assert.deepEqual(f.calls.inputs[0].opts, { pooling: "cls", normalize: true });
});

test("embedder: queries get the bge instruction prefix", async () => {
  const f = fakePipelineLoader();
  const e = createEmbedder({ config: loadVectorConfig(ENV), loadPipeline: f.load });
  await e.embedQuery("  usb exfiltration ");
  assert.equal(f.calls.inputs[0].batch[0], QUERY_PREFIX + "usb exfiltration");
});

test("embedder: loads the model once, even for concurrent callers; batches by batchSize", async () => {
  const f = fakePipelineLoader();
  const cfg = loadVectorConfig({ ...ENV, EMBEDDING_BATCH_SIZE: "2" });
  const e = createEmbedder({ config: cfg, loadPipeline: f.load });
  const texts = ["a", "b", "c", "d", "e"];
  const [r1, r2] = await Promise.all([e.embedDocuments(texts), e.embedDocuments(["z"])]);
  assert.equal(f.calls.loads, 1);
  assert.equal(r1.length, 5);
  assert.equal(r2.length, 1);
  assert.deepEqual(f.calls.inputs.map((c) => c.batch.length).sort(), [1, 1, 2, 2]);
});

test("embedder: a failed model load is reported safely and retried next time", async () => {
  const f = fakePipelineLoader(undefined, { failLoads: 1 });
  const e = createEmbedder({ config: loadVectorConfig(ENV), loadPipeline: f.load });
  await assert.rejects(e.embedDocuments(["x"]), (err) => {
    assert.equal(err.code, "EMBEDDING_MODEL_UNAVAILABLE");
    assert.equal(err.status, 503);
    return true;
  });
  const [v] = await e.embedDocuments(["x"]);
  assert.equal(v.length, 384);
  assert.equal(f.calls.loads, 2);
});

test("embedder: wrong-size output and empty input are rejected", async () => {
  const bad = createEmbedder({ config: loadVectorConfig(ENV), loadPipeline: fakePipelineLoader(undefined, { dims: 10 }).load });
  await assert.rejects(bad.embedDocuments(["x"]), (e) => e.code === "EMBEDDING_FAILED");
  const ok = createEmbedder({ config: loadVectorConfig(ENV), loadPipeline: fakePipelineLoader().load });
  for (const input of [[], [""], ["  "], [null], "text"]) {
    await assert.rejects(ok.embedDocuments(input), (e) => e.code === "VECTOR_INVALID_INPUT");
  }
});

// ---- store (fake Qdrant client) -------------------------------------------
function fakeClient(state = {}) {
  const calls = [];
  const rec = (name, impl) => async (...a) => { calls.push([name, ...a]); return impl(...a); };
  return {
    calls,
    collectionExists: rec("collectionExists", async () => ({ exists: !!state.info })),
    getCollection: rec("getCollection", async () => state.info),
    createCollection: rec("createCollection", async (n, body) => {
      state.info = { status: "green", points_count: 0, payload_schema: {}, config: { params: { vectors: body.vectors } } };
    }),
    createPayloadIndex: rec("createPayloadIndex", async (n, body) => {
      state.info.payload_schema[body.field_name] = { data_type: body.field_schema };
    }),
    getCollections: rec("getCollections", async () => {
      if (state.down) throw new TypeError("fetch failed");
      return { collections: [] };
    }),
    upsert: rec("upsert", async () => ({})),
    delete: rec("delete", async () => ({})),
    // Current client API: query() returns { points }. (search() no longer exists.)
    query: rec("query", async () => ({ points: state.hits ?? [] })),
    retrieve: rec("retrieve", async () => state.retrieved ?? []),
    count: rec("count", async () => ({ count: 3 })),
  };
}
const vec = () => Array.from({ length: 384 }, () => 0.05);

test("store: ensureCollection creates collection 384/Cosine and both payload indexes", async () => {
  const client = fakeClient();
  const store = createVectorStore({ config: loadVectorConfig(ENV), client });
  const r = await store.ensureCollection();
  assert.equal(r.created, true);
  assert.deepEqual(r.createdIndexes, ["case_id", "kind"]);
  const create = client.calls.find((c) => c[0] === "createCollection");
  assert.deepEqual(create[2], { vectors: { size: 384, distance: "Cosine" } });
  const second = await store.ensureCollection();
  assert.equal(second.created, false);
  assert.deepEqual(second.createdIndexes, []);
});

test("store: a collection with the wrong size or distance is never touched, only reported", async () => {
  const client = fakeClient({
    info: { points_count: 5, payload_schema: {}, config: { params: { vectors: { size: 768, distance: "Dot" } } } },
  });
  const store = createVectorStore({ config: loadVectorConfig(ENV), client });
  await assert.rejects(store.ensureCollection(), (e) => {
    assert.equal(e.code, "QDRANT_COLLECTION_MISMATCH");
    assert.match(e.message, /768/);
    return true;
  });
  assert.ok(!client.calls.some((c) => ["createCollection", "createPayloadIndex", "delete"].includes(c[0])));
});

test("store: search builds the case and kind filters; empty case list returns nothing without a query", async () => {
  const client = fakeClient({ hits: [{ id: "abc", score: 0.8, payload: { kind: "evidence" } }] });
  const store = createVectorStore({ config: loadVectorConfig(ENV), client });
  const hits = await store.search({ vector: vec(), caseIds: [1, 2], kind: "evidence", limit: 5 });
  assert.deepEqual(hits, [{ id: "abc", score: 0.8, payload: { kind: "evidence" } }]);
  const body = client.calls.find((c) => c[0] === "query")[2];
  assert.deepEqual(body.filter, {
    must: [{ key: "case_id", match: { any: [1, 2] } }, { key: "kind", match: { value: "evidence" } }],
  });
  assert.deepEqual(body.query, vec());
  assert.equal(body.with_vector, false);

  client.calls.length = 0;
  assert.deepEqual(await store.search({ vector: vec(), caseIds: [] }), []);
  assert.equal(client.calls.length, 0);

  await store.search({ vector: vec() });
  assert.equal(client.calls.at(-1)[2].filter, undefined);
});

test("store: invalid search and upsert input is rejected before calling Qdrant", async () => {
  const client = fakeClient();
  const store = createVectorStore({ config: loadVectorConfig(ENV), client });
  await assert.rejects(store.search({ vector: [1, 2] }), (e) => e.code === "VECTOR_INVALID_INPUT");
  await assert.rejects(store.search({ vector: vec(), limit: 0 }), (e) => e.code === "VECTOR_INVALID_INPUT");
  await assert.rejects(store.search({ vector: vec(), kind: "case" }), (e) => e.code === "VECTOR_INVALID_INPUT");
  await assert.rejects(store.upsertPoints([{ id: "x", vector: [1], payload: {} }]), (e) => e.code === "VECTOR_INVALID_INPUT");
  assert.equal(client.calls.length, 0);
});

test("errors: Qdrant failures map to safe codes", () => {
  assert.equal(toQdrantError(new TypeError("fetch failed")).code, "QDRANT_UNAVAILABLE");
  assert.equal(toQdrantError(Object.assign(new Error("x"), { status: 403 })).code, "QDRANT_AUTH_FAILED");
  const progErr = new TypeError("c.search is not a function");
  assert.equal(toQdrantError(progErr), progErr); // programming mistakes are not relabelled
  const e = toQdrantError(Object.assign(new Error("secret-api-key leaked"), { status: 500 }), "search");
  assert.equal(e.code, "QDRANT_ERROR");
  assert.ok(!e.message.includes("secret-api-key"));
});

// ---- health ---------------------------------------------------------------
test("health: reports Qdrant down, missing collection, and healthy states", async () => {
  const cfg = loadVectorConfig(ENV);
  const embedder = createEmbedder({ config: cfg, loadPipeline: fakePipelineLoader().load });

  let r = await checkVectorHealth({ store: createVectorStore({ config: cfg, client: fakeClient({ down: true }) }), embedder });
  assert.equal(r.ok, false);
  assert.equal(r.qdrant.status, "error");
  assert.equal(r.qdrant.code, "QDRANT_UNAVAILABLE");

  r = await checkVectorHealth({ store: createVectorStore({ config: cfg, client: fakeClient() }), embedder });
  assert.equal(r.ok, false);
  assert.match(r.collection.message, /does not exist/);

  const client = fakeClient();
  const store = createVectorStore({ config: cfg, client });
  await store.ensureCollection();
  r = await checkVectorHealth({ store, embedder, includeEmbedding: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.embedding, { status: "ok", dimensions: 384 });
});

test("health: a collection missing a payload index is not healthy", async () => {
  const cfg = loadVectorConfig(ENV);
  const client = fakeClient({
    info: { points_count: 0, payload_schema: { kind: { data_type: "keyword" } }, config: { params: { vectors: { size: 384, distance: "Cosine" } } } },
  });
  const r = await checkVectorHealth({ store: createVectorStore({ config: cfg, client }), embedder: null });
  assert.equal(r.ok, false);
  assert.match(r.collection.message, /case_id/);
});

// ---- needs no running Qdrant: nothing listens on port 1 ------------------------
test("an unreachable Qdrant gives a safe QDRANT_UNAVAILABLE error and a failing health report", async () => {
  const dead = loadVectorConfig({ QDRANT_URL: "http://127.0.0.1:1", QDRANT_TIMEOUT_MS: "2000" });
  const deadStore = createVectorStore({ config: dead });
  await assert.rejects(deadStore.ping(), (e) => e.code === "QDRANT_UNAVAILABLE" && e.status === 503);
  const report = await checkVectorHealth({ store: deadStore, embedder: null });
  assert.equal(report.ok, false);
  assert.equal(report.qdrant.status, "error");
  assert.equal(report.qdrant.code, "QDRANT_UNAVAILABLE");
});

// ---- the REAL Transformers.js pipeline code, with a stub tokenizer and model ------
// These do not load any model weights. They verify how the library applies the options
// this project passes (pooling "cls", normalize, truncation). Whether the bge model
// itself is CLS-pooled is a model fact, checked separately with `npm run vector:health -- --embedding`.
function stubbedPipeline({ batch = 3, tokens = 5, hidden = 384, tokenizerLog = [] } = {}) {
  const data = new Float32Array(batch * tokens * hidden);
  for (let b = 0; b < batch; b++)
    for (let t = 0; t < tokens; t++)
      for (let d = 0; d < hidden; d++)
        data[(b * tokens + t) * hidden + d] = t === 0 ? (b + 1) * (1 + d / 100) : 50 + t;
  const tokenizer = (texts, opts) => {
    tokenizerLog.push(opts);
    return { attention_mask: new Tensor("int64", new BigInt64Array(batch * tokens).fill(1n), [batch, tokens]) };
  };
  const model = async () => ({ last_hidden_state: new Tensor("float32", data, [batch, tokens, hidden]) });
  return new FeatureExtractionPipeline({ task: "feature-extraction", model, tokenizer });
}

test("library: pooling cls + normalize returns the L2-normalized CLS vector, 384 dims", async () => {
  const pipe = stubbedPipeline();
  const out = await pipe(["a", "b", "c"], { pooling: "cls", normalize: true });
  assert.deepEqual(out.dims, [3, 384]);
  const rows = out.tolist();
  for (let b = 0; b < 3; b++) {
    assert.ok(Math.abs(Math.hypot(...rows[b]) - 1) < 1e-5, "unit length");
    const cls = Array.from({ length: 384 }, (_, d) => (b + 1) * (1 + d / 100));
    const n = Math.hypot(...cls);
    cls.forEach((x, d) => assert.ok(Math.abs(x / n - rows[b][d]) < 1e-5));
  }
  // mean pooling would give a different answer here, so this test can tell them apart
  const mean = await pipe(["a", "b", "c"], { pooling: "mean", normalize: true });
  assert.ok(Math.abs(mean.tolist()[0][0] - rows[0][0]) > 1e-3);
});

test("enforceMaxTokens: 512-token cut-off is passed to the tokenizer, once, keeping padding/truncation", async () => {
  const log = [];
  const pipe = stubbedPipeline({ tokenizerLog: log });
  enforceMaxTokens(pipe, 512);
  enforceMaxTokens(pipe, 512); // second call must not wrap again
  await pipe(["a", "b", "c"], { pooling: "cls", normalize: true });
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], { padding: true, truncation: true, max_length: 512 });
});

test("enforceMaxTokens: leaves plain functions without a tokenizer untouched", () => {
  const fn = async () => ({});
  assert.equal(enforceMaxTokens(fn, 512), fn);
});

test("embedder end to end through the real pipeline code: 384 unit vectors, cls, 512-token cut-off", async () => {
  const log = [];
  const e = createEmbedder({
    config: loadVectorConfig(ENV),
    loadPipeline: async () => stubbedPipeline({ tokenizerLog: log }),
  });
  const vecs = await e.embedDocuments(["one", "two", "three"]);
  assert.equal(vecs.length, 3);
  for (const v of vecs) {
    assert.equal(v.length, 384);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6);
  }
  assert.deepEqual(log[0], { padding: true, truncation: true, max_length: 512 });
});
