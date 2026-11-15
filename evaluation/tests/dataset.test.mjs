import test from "node:test";
import assert from "node:assert/strict";
import { generateDataset, buildQrels, loadQueries, auditQueries, tierRecords, loadDataset, recordSha256, EVENT_RECORDS_PER_GROUP } from "../src/dataset.mjs";
import { SEED, CASES } from "../config.mjs";

const ds = generateDataset();
const queries = loadQueries();
const qrels = buildQrels(queries, ds.records);

test("generation is deterministic for a seed and differs for another", () => {
  assert.equal(generateDataset().meta.content_sha256, ds.meta.content_sha256);
  assert.notEqual(generateDataset({ seed: SEED + 1 }).meta.content_sha256, ds.meta.content_sha256);
});

test("2000 records; the 500 tier is an exact subset; cases are used evenly", () => {
  assert.equal(ds.records.length, 2000);
  const small = tierRecords(ds, 500);
  assert.equal(small.length, 500);
  assert.ok(small.every((r) => ds.records.includes(r)));
  const per = new Array(CASES).fill(0);
  for (const r of ds.records) per[r.case_index] += 1;
  assert.ok(per.every((n) => n === 2000 / CASES));
});

test("no duplicate records, unique hashes, no unfilled slots", () => {
  const text = ds.records.map((r) => `${r.title}|${r.description}|${r.extracted_text}`.toLowerCase());
  assert.equal(new Set(text).size, 2000);
  assert.equal(new Set(ds.records.map((r) => r.sha256)).size, 2000);
  assert.ok(ds.records.every((r) => r.sha256 === recordSha256(r.key) && !/[{}]/.test(r.title + r.description + r.extracted_text)));
});

test("queries: 40, with the planned category mix", () => {
  assert.equal(queries.length, 40);
  const n = {};
  for (const q of queries) n[q.category] = (n[q.category] ?? 0) + 1;
  assert.deepEqual(n, { exact_keyword: 8, partial_match: 8, semantic: 10, related_concept: 8, no_answer: 6 });
  assert.equal(new Set(queries.map((q) => q.id)).size, 40);
});

test("labels come from group membership: grade 2 = target group, 1 = related groups, none for no-answer", () => {
  const byKey = new Map(ds.records.map((r) => [r.key, r]));
  for (const q of queries) {
    const grades = qrels[q.id];
    if (q.target_group === null) { assert.deepEqual(grades, {}); continue; }
    const two = Object.keys(grades).filter((k) => grades[k] === 2);
    assert.equal(two.length, EVENT_RECORDS_PER_GROUP);
    assert.ok(two.every((k) => byKey.get(k).group === q.target_group));
    assert.ok(Object.keys(grades).filter((k) => grades[k] === 1).every((k) => q.related_groups.includes(byKey.get(k).group)));
    assert.ok(Object.keys(grades).every((k) => byKey.get(k).kind === "event"), "traps and fillers are never relevant");
  }
});

test("every relevant record is in the 500 tier, so both sizes share the same labels", () => {
  const keys = new Set(tierRecords(ds, 500).map((r) => r.key));
  for (const g of Object.values(qrels)) for (const k of Object.keys(g)) assert.ok(keys.has(k));
});

test("each event group has canonical-wording and paraphrase records; traps exist for keyword confusion", () => {
  const w = {};
  for (const r of ds.records.filter((r) => r.kind === "event")) (w[r.group] ??= { canonical: 0, paraphrase: 0 })[r.wording] += 1;
  assert.equal(Object.keys(w).length, 14);
  assert.ok(Object.values(w).every((x) => x.canonical === 4 && x.paraphrase === 4));
  assert.ok(ds.records.filter((r) => r.kind === "trap").length > 100);
});

test("query audit: semantic queries share much less wording with their targets than keyword queries", () => {
  const audit = auditQueries(queries, ds.records, qrels);
  const avg = (cat) => { const v = audit.filter((a) => a.category === cat).map((a) => a.coverage); return v.reduce((x, y) => x + y, 0) / v.length; };
  assert.ok(avg("semantic") < 0.5 && avg("exact_keyword") > 0.9);
});

test("committed data files match a fresh deterministic build", () => {
  const loaded = loadDataset();
  assert.equal(loaded.dataset.meta.content_sha256, ds.meta.content_sha256);
});
