// Deterministic dataset, query and relevance-label construction.
//   generateDataset()  : 2000 records; the 500-record tier is a subset of them
//   buildQrels()       : graded labels from GROUP MEMBERSHIP only (grade 2 target, 1 related, else 0)
//   auditQueries()     : how much of each query's wording appears in its relevant records
// Nothing here looks at any search result.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeRng } from "./rng.mjs";
import { EVENT_GROUPS, TRAP_GROUPS, FILLER_TEMPLATES, SLOT_POOLS } from "./corpus.mjs";
import { SEED, CASES, DATASET_VERSION, SIZES, MAX_RECORDS_PER_CASE } from "../config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, "..", "data");
export const EVENT_RECORDS_PER_GROUP = 8; // 4 canonical-wording + 4 paraphrase
export const TRAP_RECORDS_PER_GROUP = 28;
export const TRAP_RECORDS_IN_SMALL = 8;

export const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");
// Stored in evidence.sha256 so the runner can map evidence_id -> record key without a side file.
export const recordSha256 = (key) => sha256Hex(`tracex-eval:${key}`);

function slots(rng, counter) {
  const prefix = rng.pick(["WS-", "LT-", "SRV-"]);
  const net = rng.pick(["192.0.2", "198.51.100", "203.0.113"]);
  return {
    host: `${prefix}${100 + rng.int(800)}`,
    user: rng.pick(SLOT_POOLS.users),
    ip: `${net}.${1 + rng.int(253)}`,
    n: String(3 + rng.int(900)),
    file: rng.pick(SLOT_POOLS.files),
    day: rng.pick(SLOT_POOLS.days),
    ref: `x${counter.toString(36)}${rng.int(46656).toString(36)}`,
  };
}
const fill = (tpl, s) => tpl.replace(/\{(\w+)\}/g, (_, k) => s[k]);

export function generateDataset({ seed = SEED, small = SIZES[0], large = SIZES[1], cases = CASES } = {}) {
  const rng = makeRng(seed);
  let counter = 0;
  const raw = [];
  const push = (r) => raw.push({ ...r });
  const make = (g, i, variant, kind, tier, type) => {
    const s = slots(rng, (counter += 1));
    return {
      kind, group: g, tier, type,
      title: fill(variant.titles[i % 2], s),
      description: fill(variant.descs[(i >> 1) % 2], s),
      extracted_text: fill(variant.texts[0], s),
    };
  };

  for (const g of EVENT_GROUPS) {
    for (let i = 0; i < EVENT_RECORDS_PER_GROUP; i += 1) {
      const variant = i < 4 ? g.kw : g.para;
      push({ ...make(g.id, i % 4, variant, "event", small, g.type), wording: i < 4 ? "canonical" : "paraphrase" });
    }
  }
  for (const t of TRAP_GROUPS) {
    for (let i = 0; i < TRAP_RECORDS_PER_GROUP; i += 1) {
      push({ ...make(t.id, i, t, "trap", i < TRAP_RECORDS_IN_SMALL ? small : large, t.type), wording: "trap" });
    }
  }
  const events = EVENT_GROUPS.length * EVENT_RECORDS_PER_GROUP;
  const traps = TRAP_GROUPS.length * TRAP_RECORDS_PER_GROUP;
  const smallFillers = small - events - TRAP_GROUPS.length * TRAP_RECORDS_IN_SMALL;
  const fillers = large - events - traps;
  if (smallFillers < 0 || fillers < smallFillers) throw new Error("Tier sizes do not leave room for the planned records.");
  for (let i = 0; i < fillers; i += 1) {
    const f = FILLER_TEMPLATES[i % FILLER_TEMPLATES.length];
    const s = slots(rng, (counter += 1));
    push({
      kind: "filler", group: "F" + String((i % FILLER_TEMPLATES.length) + 1).padStart(2, "0"),
      tier: i < smallFillers ? small : large, type: f.type, wording: "filler",
      title: fill(f.title, s), description: fill(f.descs[rng.int(f.descs.length)], s), extracted_text: fill(f.text, s),
    });
  }

  const records = rng.shuffle(raw).map((r, idx) => {
    const key = `R${String(idx + 1).padStart(4, "0")}`;
    return {
      key, kind: r.kind, group: r.group, wording: r.wording, tier: r.tier, case_index: idx % cases,
      type: r.type, title: r.title, description: r.description, extracted_text: r.extracted_text,
      sha256: recordSha256(key),
    };
  });

  checkInvariants(records, { small, large });
  const counts = {};
  for (const r of records) counts[`${r.kind}_${r.tier}`] = (counts[`${r.kind}_${r.tier}`] ?? 0) + 1;
  return {
    meta: {
      dataset_version: DATASET_VERSION, seed, total: records.length, small, large, cases,
      records_in_small_tier: records.filter((r) => r.tier <= small).length,
      event_groups: EVENT_GROUPS.length, trap_groups: TRAP_GROUPS.length, filler_templates: FILLER_TEMPLATES.length,
      by_kind_and_tier_max: counts, content_sha256: sha256Hex(JSON.stringify(records)),
    },
    records,
  };
}

const norm = (r) => `${r.title}\n${r.description}\n${r.extracted_text}`.toLowerCase().replace(/\s+/g, " ").trim();

export function checkInvariants(records, { small, large }) {
  const seen = new Set();
  for (const r of records) {
    const n = norm(r);
    if (seen.has(n)) throw new Error(`Duplicate record content: ${r.key}`);
    seen.add(n);
    if (r.title.length > 200) throw new Error(`Title too long: ${r.key}`);
    if (/[{}]/.test(n)) throw new Error(`Unfilled slot in ${r.key}`);
  }
  if (records.length !== large) throw new Error(`Expected ${large} records, got ${records.length}.`);
  if (records.filter((r) => r.tier <= small).length !== small) throw new Error(`Small tier is not ${small} records.`);
  if (new Set(records.map((r) => r.sha256)).size !== records.length) throw new Error("sha256 values must be unique.");
  for (const size of [small, large]) {
    const per = {};
    for (const r of records.filter((x) => x.tier <= size)) per[r.case_index] = (per[r.case_index] ?? 0) + 1;
    if (Math.max(...Object.values(per)) > MAX_RECORDS_PER_CASE) throw new Error(`A case would hold more than ${MAX_RECORDS_PER_CASE} records (evidence_no overflow).`);
  }
}

export function tierRecords(dataset, size) {
  return dataset.records.filter((r) => r.tier <= size);
}

export function loadQueries(path = join(DATA_DIR, "queries.json")) {
  return JSON.parse(readFileSync(path, "utf8")).queries;
}

// qrels[queryId] = { recordKey: grade } with only non-zero grades.
export function buildQrels(queries, records) {
  const byGroup = new Map();
  for (const r of records) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group).push(r.key);
  }
  const qrels = {};
  for (const q of queries) {
    const grades = {};
    if (q.target_group !== null) {
      const target = byGroup.get(q.target_group);
      if (!target?.length) throw new Error(`${q.id}: target group ${q.target_group} has no records.`);
      for (const rel of q.related_groups) {
        if (!byGroup.has(rel)) throw new Error(`${q.id}: related group ${rel} has no records.`);
        for (const k of byGroup.get(rel)) grades[k] = 1;
      }
      for (const k of target) grades[k] = 2; // target wins if a group is listed twice
    } else if (q.related_groups.length) {
      throw new Error(`${q.id}: a no_answer query cannot have related groups.`);
    }
    qrels[q.id] = grades;
  }
  return qrels;
}

const STOP = new Set("the a an and or of to in on for with was were is are be by at as it its that this from into than then who what how did does their them they had has have not but all any can could would should about after before over under again onto one more out".split(" "));
export const tokens = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t));

// For each query: share of its content words found anywhere in its grade-2 records.
// High coverage on a "semantic" query would mean the query was written from the record wording.
export function auditQueries(queries, records, qrels) {
  const byKey = new Map(records.map((r) => [r.key, r]));
  return queries.map((q) => {
    const qt = [...new Set(tokens(q.text))];
    const vocab = new Set();
    for (const [key, g] of Object.entries(qrels[q.id])) {
      if (g >= 2) for (const t of tokens(norm(byKey.get(key)))) vocab.add(t);
    }
    const hit = qt.filter((t) => vocab.has(t));
    return { id: q.id, category: q.category, query_terms: qt.length, terms_in_relevant_records: hit.length,
      coverage: qt.length ? Number((hit.length / qt.length).toFixed(3)) : 0 };
  });
}

export function writeDatasetFiles(dir = DATA_DIR) {
  const dataset = generateDataset();
  const queries = loadQueries(join(dir, "queries.json"));
  const qrels = buildQrels(queries, dataset.records);
  const audit = auditQueries(queries, dataset.records, qrels);
  writeFileSync(join(dir, "dataset.json"), JSON.stringify(dataset) + "\n");
  writeFileSync(join(dir, "qrels.json"), JSON.stringify(qrels, null, 1) + "\n");
  writeFileSync(join(dir, "query-audit.json"), JSON.stringify(audit, null, 1) + "\n");
  return { dataset, queries, qrels, audit };
}

// Reads the committed files and refuses to continue if they differ from a fresh deterministic build.
export function loadDataset(dir = DATA_DIR) {
  const dataset = JSON.parse(readFileSync(join(dir, "dataset.json"), "utf8"));
  const fresh = generateDataset({ seed: dataset.meta.seed });
  if (sha256Hex(JSON.stringify(dataset.records)) !== fresh.meta.content_sha256) {
    throw new Error("evaluation/data/dataset.json does not match a fresh generation. Run: node evaluation/scripts/generate.mjs");
  }
  const queries = loadQueries(join(dir, "queries.json"));
  const qrels = buildQrels(queries, dataset.records);
  const stored = JSON.parse(readFileSync(join(dir, "qrels.json"), "utf8"));
  if (JSON.stringify(stored) !== JSON.stringify(qrels)) {
    throw new Error("evaluation/data/qrels.json is stale. Run: node evaluation/scripts/generate.mjs");
  }
  return { dataset, queries, qrels };
}
