// Static SQL-contract tests: check the retrieval repository against Person A's REAL SQL files
// by reading them as text. No MySQL needed; nothing is executed; nothing in database/ is changed.
//
//   cd app && npm run test:retrieval
//
// The SQL files are found at <repo>/database/ or in TRACEX_DATABASE_DIR. If 01_schema.sql,
// 02_access.sql and 03_routines.sql are missing, every test here is SKIPPED (never "passed").
//
// What this proves: every view, table and column the repository names exists in the supplied
// SQL; the investigator statements touch only views granted to tracex_investigator; the admin
// statements touch only tables granted to tracex_admin; values are bound with `?`, never
// concatenated; and it records, as tests, the places where the supplied SQL does NOT give
// retrieval what it needs (tests marked `todo` fail until Person A makes the change; a `todo`
// failure is reported but does not fail the run).
// What it does NOT prove: that MySQL accepts the statements at runtime (see live.test.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRetrievalRepository, ADMIN_ROLE_NAME } from "../../src/lib/retrieval/repository.js";

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
const allViewSql = accessSql + "\n" + routinesSql;

// ---- parse the schema: table -> Set(columns) ---------------------------------------------
function parseSchema(sql) {
  const tables = new Map();
  for (const m of sql.matchAll(/CREATE TABLE\s+`?(\w+)`?\s*\(\n([\s\S]*?)\n\)\s*ENGINE/g)) {
    const cols = new Set();
    for (const line of m[2].split("\n")) {
      const c = line.match(/^\s{2}(?!CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|KEY|--)(\w+)\s+(.+?),?\s*$/);
      if (c) cols.add(c[1]);
    }
    tables.set(m[1], cols);
  }
  return tables;
}

// ---- parse the views: name -> { columns: Set, body } -------------------------------------
function parseViews(sql) {
  const views = new Map();
  for (const m of sql.matchAll(/CREATE OR REPLACE SQL SECURITY DEFINER VIEW\s+(\w+)\s+AS\n([\s\S]*?);/g)) {
    const body = m[2];
    const select = body.match(/^SELECT\s+(?:DISTINCT\s+)?([\s\S]*?)\nFROM\s/);
    const cols = new Set();
    for (const part of select[1].split(",")) {
      const t = part.trim();
      const alias = t.match(/\s+AS\s+(\w+)$/i);
      cols.add(alias ? alias[1] : t.split(".").pop());
    }
    views.set(m[1], { columns: cols, body });
  }
  return views;
}

// ---- parse grants for one MySQL role: { selectable: Set<object names>, executeFunctions } ---
function parseGrants(sql, role) {
  const selectable = new Set();
  const re = new RegExp(`^GRANT\\s+(.+?)\\s+ON\\s+tracex\\.\`?(\\w+)\`?\\s+TO\\s+(.+?);`, "gim");
  for (const m of sql.matchAll(re)) {
    if (!m[3].includes(`'${role}'`)) continue;
    if (m[1].split(",").map((p) => p.trim().toUpperCase()).includes("SELECT")) selectable.add(m[2]);
  }
  return selectable;
}

const tables = parseSchema(schemaSql);
const views = parseViews(allViewSql);
const investigatorSelect = parseGrants(allViewSql, "tracex_investigator");
const adminSelect = parseGrants(allViewSql, "tracex_admin");

// ---- record every statement the repository can send, for both roles -------------------------
async function recordSql() {
  const log = [];
  const db = {
    async withSession(session, work) {
      return work({
        async query(sql, params = []) {
          log.push({ role: session.role, sql, params });
          if (/FROM app_user u/.test(sql)) return [{ user_id: session.userId }];
          return [];
        },
      });
    },
  };
  const repo = createRetrievalRepository({ db });
  // sentinel values: if any of these ever appears inside the SQL text, a value was concatenated
  const SENT = { ev: [987654, 987655], fi: [876543], cases: [765432, 765433] };
  for (const role of ["investigator", "admin"]) {
    const session = { role, userId: 3 };
    await repo.resolveCaseScope(session, null);
    await repo.resolveCaseScope(session, []).catch(() => {}); // idList refuses an empty list
    await repo.resolveCaseScope(session, SENT.cases).catch(() => {}); // fewer rows than asked: refusal is expected
    await repo.loadAuthoritativeRows(session, { evidenceIds: SENT.ev, findingIds: SENT.fi, caseIds: SENT.cases });
  }
  return { log, SENT };
}

// "FROM v_my_evidence e JOIN v_my_analyses a" -> Map(alias -> object name)
function aliases(sql) {
  const map = new Map();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+`?(\w+)`?\s+(\w+)\b/g)) {
    if (!["ON", "WHERE", "JOIN", "LEFT", "INNER"].includes(m[2].toUpperCase())) map.set(m[2], m[1]);
  }
  return map;
}
function objectsIn(sql) {
  return [...new Set([...sql.matchAll(/\b(?:FROM|JOIN)\s+`?(\w+)`?/g)].map((m) => m[1]))];
}
const columnsOf = (name) => views.get(name)?.columns ?? tables.get(name);

// ======================================================================================
test("the supplied SQL parses: 15 tables and the views retrieval needs", { skip }, () => {
  assert.equal(tables.size, 15);
  for (const v of ["v_user_case_access", "v_my_cases", "v_my_evidence", "v_my_analyses", "v_my_findings"]) {
    assert.ok(views.has(v), `${v} is defined`);
  }
});

test("every statement is a single parameterized SELECT: values bound with ?, none concatenated", { skip }, async () => {
  const { log, SENT } = await recordSql();
  assert.ok(log.length >= 8);
  for (const { sql, params } of log) {
    assert.match(sql.trim(), /^SELECT\b/i, "read-only");
    assert.ok(!sql.includes(";"), "one statement only");
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CALL)\b/i.test(sql));
    const marks = (sql.match(/\?/g) ?? []).length;
    assert.equal(marks, params.length, "one ? per bound value");
    for (const n of [...SENT.ev, ...SENT.fi, ...SENT.cases]) assert.ok(!sql.includes(String(n)), `value ${n} was concatenated into the SQL`);
  }
  // the sentinel values really were sent, as parameters
  assert.ok(log.some((l) => l.params.includes(SENT.ev[0])));
});

test("investigator statements read ONLY views granted to tracex_investigator (02/03 GRANT lines)", { skip }, async () => {
  const { log } = await recordSql();
  const inv = log.filter((l) => l.role === "investigator");
  assert.ok(inv.length >= 3);
  for (const { sql } of inv) {
    for (const obj of objectsIn(sql)) {
      assert.ok(views.has(obj), `${obj} is a view (investigators have no base-table rights)`);
      assert.ok(investigatorSelect.has(obj), `tracex_investigator has SELECT on ${obj}`);
    }
  }
});

test("admin statements read ONLY objects granted to tracex_admin, and no v_my_* view (not granted to it)", { skip }, async () => {
  const { log } = await recordSql();
  const adm = log.filter((l) => l.role === "admin");
  assert.ok(adm.length >= 4);
  for (const { sql } of adm) {
    for (const obj of objectsIn(sql)) {
      assert.ok(adminSelect.has(obj), `tracex_admin has SELECT on ${obj}`);
      assert.ok(!/^v_my_/.test(obj));
    }
    assert.ok(!/\bfn_\w+\(/.test(sql), "no fn_* call: EXECUTE on functions is not granted to tracex_admin");
  }
});

test("every alias.column the repository uses exists in the view or table it names", { skip }, async () => {
  const { log } = await recordSql();
  for (const { sql } of log) {
    const map = aliases(sql);
    const noStrings = sql.replace(/'[^']*'/g, "''");
    for (const m of noStrings.matchAll(/\b([a-z]{1,2})\.(\w+)\b/g)) {
      const obj = map.get(m[1]);
      assert.ok(obj, `alias ${m[1]} is declared in: ${sql.slice(0, 60)}`);
      const cols = columnsOf(obj);
      assert.ok(cols, `${obj} is known`);
      assert.ok(cols.has(m[2]), `${obj}.${m[2]} exists`);
    }
  }
});

test("admin check mirrors fn_is_admin: active user + role 'Administrator' (same literal as 03_routines.sql)", { skip }, () => {
  const fn = routinesSql.match(/CREATE FUNCTION fn_is_admin[\s\S]*?END\$\$/)[0];
  assert.ok(fn.includes(`r.role_name = '${ADMIN_ROLE_NAME}'`));
  assert.ok(fn.includes("u.is_active = 1"));
  assert.ok(tables.get("app_user").has("is_active"));
  assert.ok(tables.get("role").has("role_name"));
});

// ---- how access is enforced by the views the investigator path relies on ----------------------
test("views grant access only through an ACTIVE assignment of an ACTIVE user, for @tracex_user_id", { skip }, () => {
  const access = views.get("v_user_case_access").body;
  assert.ok(/revoked_at IS NULL/.test(access) && /is_active = 1/.test(access));
  assert.ok(/fn_current_user_id\(\)/.test(views.get("v_my_cases").body));
  assert.ok(/fn_current_user_id\(\)/.test(views.get("v_my_evidence").body));
  assert.ok(/JOIN v_my_evidence/.test(views.get("v_my_analyses").body), "analyses inherit evidence access");
  assert.ok(/JOIN v_my_analyses/.test(views.get("v_my_findings").body), "findings inherit analysis access");
  assert.match(accessSql, /RETURN @tracex_user_id/);
});

test("DOCUMENTED MISMATCH: v_my_evidence and v_my_findings do NOT filter withdrawn evidence", { skip }, () => {
  assert.ok(!/status/.test(views.get("v_my_evidence").body.split("FROM")[1]), "no status filter in the view's FROM/WHERE");
  assert.ok(views.get("v_my_evidence").columns.has("status"), "but the status column is exposed, so the service filters on it");
  assert.ok(!views.get("v_my_findings").columns.has("evidence_id"), "findings view has no evidence_id: a join is needed");
  assert.ok(!views.get("v_my_findings").columns.has("case_id"));
});

test("DOCUMENTED MISMATCH: the admin account has no grant on any v_my_* view or fn_* function", { skip }, () => {
  for (const v of views.keys()) if (/^v_my_/.test(v)) assert.ok(!adminSelect.has(v), `${v} not granted to tracex_admin`);
  assert.ok(adminSelect.has("v_current_custody"));
  assert.ok(!/GRANT\s+EXECUTE\s+ON\s+FUNCTION/i.test(allViewSql), "no EXECUTE grant on functions to anyone");
});

test("api-contract.md names resolve to real views and investigator evidence exposes the stale-check version", { skip }, () => {
  const contractPath = join(dbDir, "..", "docs", "api-contract.md");
  if (!existsSync(contractPath)) return;
  const contract = readFileSync(contractPath, "utf8");
  const named = [...new Set(contract.match(/\bv_[a-z_]+\b/g))];
  for (const v of named) assert.ok(views.has(v), `api-contract.md mentions ${v}: defined in the SQL`);
  assert.ok(views.get("v_my_evidence").columns.has("content_version"));
});

// Person A retrieval requirements are mandatory checks.
test("PERSON A CHANGE 1: v_my_evidence exposes content_version (stale-hit check for investigators)", { skip }, () => {
  assert.ok(views.get("v_my_evidence").columns.has("content_version"));
});

test("PERSON A CHANGE 1b: v_my_findings exposes content_version (stale-hit check for findings)", { skip }, () => {
  assert.ok(views.get("v_my_findings").columns.has("content_version"));
});

test("PERSON A CHANGE 2 (worker B1): tracex_worker can SELECT analysis, so finding points carry case_id/evidence_id", { skip }, () => {
  assert.ok(parseGrants(allViewSql, "tracex_worker").has("analysis"));
});
