// Static SQL-contract tests: check repository.js against Person A's REAL SQL files by reading
// them as text. No MySQL needed, nothing is executed, nothing in database/ is modified.
//
//   cd app && npm run test:indexing
//
// Where are the SQL files?  <repo>/database/ (two levels above app/tests/indexing/..), or the
// folder named in TRACEX_DATABASE_DIR. If 01_schema.sql, 02_access.sql and 03_routines.sql
// are not found, every test here is SKIPPED (reported as skipped, never as passed).
//
// What this proves: every table and column in the worker's SQL exists in 01_schema.sql, every
// status/operation value is a real ENUM value, every statement is covered by a tracex_worker
// grant in 02_access.sql, and the triggers in 03_routines.sql behave the way the worker's
// bookkeeping relies on. What it does NOT prove: that MySQL accepts the statements at runtime
// (that needs the live tests).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIndexRepository } from "../../src/lib/indexing/repository.js";

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = process.env.TRACEX_DATABASE_DIR
  ? resolve(process.env.TRACEX_DATABASE_DIR)
  : resolve(here, "..", "..", "..", "database");
const FILES = ["01_schema.sql", "02_access.sql", "03_routines.sql"];
const missing = FILES.filter((f) => !existsSync(join(dbDir, f)));
const skip = missing.length ? `SQL files not found in ${dbDir}: ${missing.join(", ")}` : false;

const read = (f) => readFileSync(join(dbDir, f), "utf8").replace(/\r\n/g, "\n");
const schemaSql = skip ? "" : read("01_schema.sql");
const accessSql = skip ? "" : read("02_access.sql");
const routinesSql = skip ? "" : read("03_routines.sql");

// ---- parse the schema -------------------------------------------------------
function parseSchema(sql) {
  const tables = new Map(); // name -> Map(column -> type text)
  const re = /CREATE TABLE\s+`?(\w+)`?\s*\(\n([\s\S]*?)\n\)\s*ENGINE/g;
  for (const m of sql.matchAll(re)) {
    const cols = new Map();
    for (const line of m[2].split("\n")) {
      const c = line.match(/^\s{2}(?!CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|KEY|--)(\w+)\s+(.+?),?\s*$/);
      if (c) cols.set(c[1], c[2]);
    }
    tables.set(m[1], cols);
  }
  return tables;
}

// ---- parse the worker grants ------------------------------------------------
// -> { table: { select: bool, insert: bool, update: bool, updateColumns: Set, delete: bool } }
function parseWorkerGrants(sql) {
  const grants = {};
  const slot = (t) => (grants[t] ??= { select: false, insert: false, update: false, updateColumns: new Set(), delete: false });
  for (const line of sql.split("\n")) {
    const m = line.match(/^GRANT\s+(.+?)\s+ON\s+tracex\.`?(\w+)`?\s+TO\s+'tracex_worker'\s*;/i);
    if (!m) continue;
    const [, privs, table] = m;
    const colUpdate = privs.match(/^UPDATE\s*\(([^)]*)\)$/i);
    if (colUpdate) {
      for (const c of colUpdate[1].split(",")) slot(table).updateColumns.add(c.trim());
      continue;
    }
    for (const p of privs.split(",").map((x) => x.trim().toUpperCase())) {
      if (p === "SELECT") slot(table).select = true;
      if (p === "INSERT") slot(table).insert = true;
      if (p === "UPDATE") slot(table).update = true;
      if (p === "DELETE") slot(table).delete = true;
    }
  }
  return grants;
}

// ---- record every statement the repository can run --------------------------
async function recordRepositorySql() {
  const log = [];
  const db = {
    async withSession(_session, work) {
      return work({
        query: async (sql) => {
          log.push(sql.replace(/\s+/g, " ").trim());
          // candidates for claimPending, then claims succeed
          if (/^SELECT job_id FROM index_job/.test(log.at(-1))) return [{ job_id: 1 }];
          if (log.at(-1).startsWith("SELECT")) return [];
          return { affectedRows: 1 };
        },
      });
    },
  };
  const repo = createIndexRepository({ db });
  await repo.recoverInterrupted(5);
  await repo.claimPending(10);
  await repo.fetchEvidence([1]);
  await repo.fetchFindings([1]);
  await repo.canResolveFindings();
  await repo.markIndexed("evidence", 1, 1);
  await repo.markIndexed("finding", 1, 1);
  await repo.markJobDone(1, "note");
  await repo.releaseJob(1, "e", { countAttempt: true });
  await repo.releaseJob(1, "e", { countAttempt: false });
  await repo.markJobFailed(1, "e");
  return [...new Set(log)];
}

const KEYWORDS = new Set(
  ("select from where and or in is not null set update join on as order by limit if greatest now " +
    "asc desc distinct count").split(" "),
);
const ALIASES = new Set(["f", "a", "e", "evidence_status"]); // aliases used in fetchFindings

// Splits "a = 1, b = IF(?, x, y), c = ?" at depth 0 and returns the assigned column names.
function setColumns(setPart) {
  const cols = []; let depth = 0; let cur = "";
  const flush = () => { const m = cur.match(/^\s*(\w+)\s*=/); if (m) cols.push(m[1]); cur = ""; };
  for (const ch of setPart) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) flush(); else cur += ch;
  }
  flush();
  return cols;
}

// ---------------------------------------------------------------------------
test("SQL contract: every table and column used by repository.js exists in 01_schema.sql", { skip }, async () => {
  const schema = parseSchema(schemaSql);
  assert.ok(schema.size >= 15, `expected 15 tables, parsed ${schema.size}`);
  const knownColumns = new Set([...schema.values()].flatMap((cols) => [...cols.keys()]));
  const statements = await recordRepositorySql();
  const problems = [];
  for (const sql of statements) {
    const withoutStrings = sql.replace(/'[^']*'/g, "''");
    for (const t of withoutStrings.matchAll(/\b(?:FROM|JOIN|UPDATE)\s+(\w+)/gi)) {
      if (!schema.has(t[1])) problems.push(`unknown table ${t[1]} in: ${sql}`);
    }
    for (const id of withoutStrings.toLowerCase().match(/\b[a-z_][a-z0-9_]*\b/g) ?? []) {
      if (KEYWORDS.has(id) || ALIASES.has(id) || schema.has(id) || knownColumns.has(id)) continue;
      problems.push(`unknown identifier ${id} in: ${sql}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("SQL contract: columns are read from the table that really owns them", { skip }, () => {
  const schema = parseSchema(schemaSql);
  const needs = {
    index_job: ["job_id", "evidence_id", "finding_id", "operation", "content_version", "status", "attempts", "last_error", "processed_at"],
    evidence: ["evidence_id", "case_id", "title", "description", "extracted_text", "status", "content_version", "indexed_version", "indexed_at"],
    finding: ["finding_id", "analysis_id", "title", "description", "content_version", "indexed_version", "indexed_at"],
    analysis: ["analysis_id", "evidence_id"],
  };
  for (const [table, cols] of Object.entries(needs)) {
    for (const c of cols) assert.ok(schema.get(table)?.has(c), `${table}.${c} must exist`);
  }
  // the finding row has NO case_id / evidence_id of its own: they come through analysis
  assert.equal(schema.get("finding").has("evidence_id"), false);
  assert.equal(schema.get("finding").has("case_id"), false);
});

test("SQL contract: the status and operation values used are real index_job ENUM values, attempts fits the column", { skip }, async () => {
  const jobDef = schemaSql.match(/CREATE TABLE index_job \(([\s\S]*?)\n\) ENGINE/)[1];
  const enumOf = (col) => [...jobDef.match(new RegExp(`${col}\\s+ENUM\\(([^)]*)\\)`))[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const statuses = enumOf("status");
  const operations = enumOf("operation");
  assert.deepEqual(statuses.sort(), ["done", "failed", "pending", "processing"]);
  assert.deepEqual(operations.sort(), ["delete", "upsert"]);
  const used = (await recordRepositorySql()).filter((s) => s.includes("index_job")).join(" ");
  for (const lit of used.matchAll(/status = '(\w+)'/g)) assert.ok(statuses.includes(lit[1]), lit[1]);
  assert.match(jobDef, /attempts\s+TINYINT UNSIGNED/, "attempts is TINYINT UNSIGNED: WORKER_MAX_ATTEMPTS (<= 20) fits");
  // no claim token / lease column exists: the worker must stay single-process
  for (const forbidden of ["claimed_at", "claim_token", "locked_by", "lease_until", "next_attempt_at"]) {
    assert.ok(!jobDef.includes(forbidden), `${forbidden} does not exist in index_job`);
  }
});

test("SQL contract: every statement is covered by a tracex_worker grant in 02_access.sql (except SELECT on analysis, see next test)", { skip }, async () => {
  const grants = parseWorkerGrants(accessSql);
  const unmet = [];
  for (const sql of await recordRepositorySql()) {
    const noStrings = sql.replace(/'[^']*'/g, "''");
    const upd = noStrings.match(/^UPDATE (\w+) SET (.*?) WHERE /);
    const reads = new Set([...noStrings.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)].map((m) => m[1]));
    if (upd) {
      const [, table, setPart] = upd;
      reads.add(table); // the WHERE clause reads columns of the updated table
      const g = grants[table];
      for (const col of setColumns(setPart)) {
        if (!g || !(g.update || g.updateColumns.has(col))) unmet.push(`UPDATE ${table}.${col}`);
      }
    }
    for (const t of reads) if (!grants[t]?.select) unmet.push(`SELECT on ${t}`);
  }
  assert.deepEqual([...new Set(unmet)], ["SELECT on analysis"]);
});

test("SQL contract: the worker may only UPDATE indexed_version/indexed_at on evidence and finding, and has no DELETE anywhere", { skip }, () => {
  const g = parseWorkerGrants(accessSql);
  for (const t of ["evidence", "finding"]) {
    assert.equal(g[t].update, false, `${t}: no table-wide UPDATE`);
    assert.deepEqual([...g[t].updateColumns].sort(), ["indexed_at", "indexed_version"]);
  }
  assert.deepEqual(Object.entries(g).filter(([, v]) => v.delete), []);
  assert.equal(g.audit_log.select, false);
  assert.equal(g.case_assignment, undefined);
});

// KNOWN GAP. todo: a failing todo test is reported but does not fail the run. When Person A
// adds the missing grant this starts passing; then remove the `todo` option.
test("SQL contract: worker can SELECT analysis (needed to resolve finding -> evidence -> case)", {
  skip,
  todo: "02_access.sql grants tracex_worker no privilege on analysis. Ask Person A for: GRANT SELECT ON tracex.analysis TO 'tracex_worker';",
}, () => {
  assert.equal(parseWorkerGrants(accessSql).analysis?.select, true);
});

// ---- triggers in 03_routines.sql ----------------------------------------------
function triggerBody(name) {
  const m = routinesSql.match(new RegExp(`CREATE TRIGGER ${name}\\b([\\s\\S]*?)END\\$\\$`));
  assert.ok(m, `trigger ${name} not found`);
  return m[1];
}

test("SQL contract: indexed_version / indexed_at are not content: they never bump content_version or queue a job", { skip }, () => {
  for (const [bu, au, textCols] of [
    ["trg_evidence_bu", "trg_evidence_au", ["title", "description", "extracted_text"]],
    ["trg_finding_bu", "trg_finding_au", ["title", "description"]],
  ]) {
    const before = triggerBody(bu);
    const bump = before.match(/IF (NOT[\s\S]*?)THEN\s+SET NEW\.content_version = OLD\.content_version \+ 1/);
    assert.ok(bump, `${bu}: version bump found`);
    for (const c of textCols) assert.ok(bump[1].includes(`NEW.${c}`), `${bu} bumps on ${c}`);
    assert.ok(!/indexed_version|indexed_at/.test(bump[1]), `${bu}: bump condition ignores the index bookkeeping columns`);

    const after = triggerBody(au);
    assert.ok(!/indexed_version|indexed_at/.test(after), `${au}: does not look at index bookkeeping columns`);
    assert.match(after, /content_version <> OLD\.content_version/, `${au}: queues upserts only when content_version changed`);
  }
});

test("SQL contract: withdrawing evidence queues delete jobs for the evidence AND all its findings; reactivation is impossible", { skip }, () => {
  const au = triggerBody("trg_evidence_au");
  assert.match(au, /OLD\.status = 'active' AND NEW\.status = 'withdrawn'/);
  assert.match(au, /INSERT INTO index_job \(evidence_id, operation, content_version\)\s+VALUES \(NEW\.evidence_id, 'delete'/);
  assert.match(au, /INSERT INTO index_job \(finding_id, operation, content_version\)\s+SELECT f\.finding_id, 'delete'/);
  assert.match(triggerBody("trg_evidence_bu"), /Withdrawn evidence cannot be reactivated/);
});

test("SQL contract: new evidence and new findings queue an upsert job at their starting content_version", { skip }, () => {
  assert.match(triggerBody("trg_evidence_ai"), /status = 'active'[\s\S]*INSERT INTO index_job \(evidence_id, operation, content_version\)[\s\S]*'upsert', NEW\.content_version/);
  assert.match(triggerBody("trg_finding_ai"), /INSERT INTO index_job \(finding_id, operation, content_version\)[\s\S]*'upsert', NEW\.content_version/);
});

test("SQL contract: the indexed_version CHECK allows the worker's value (never above content_version), and the backfill procedure can requeue failed jobs", { skip }, () => {
  assert.match(schemaSql, /ck_evidence_indexed_version\s+CHECK \(indexed_version IS NULL OR indexed_version <= content_version\)/);
  assert.match(schemaSql, /ck_finding_indexed_version\s+CHECK \(indexed_version IS NULL OR indexed_version <= content_version\)/);
  // sp_backfill_index_jobs only treats 'pending' and 'processing' jobs as "already queued",
  // so a record whose job ended as 'failed' (or 'done' but still stale) gets a fresh job.
  assert.match(routinesSql, /j\.status IN \('pending','processing'\)/);
});
