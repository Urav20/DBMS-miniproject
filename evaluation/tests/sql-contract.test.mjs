// Checks the evaluation code against Person A's REAL schema and routines (database/01..03_*.sql).
// These tests need the full project and FAIL (never skip) if the files are missing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerArgs, caseArgs, LOADER_CONSTANTS } from "../src/loader.mjs";
import { keywordSql } from "../src/methods/keyword.mjs";
import { evalSeedSql } from "../src/sql-transform.mjs";
import { evalCaseNumber } from "../src/eval-env.mjs";
import { generateDataset } from "../src/dataset.mjs";
import { ADMIN_USERNAME, CASES, EVIDENCE_TYPES, SIZES, MAX_RECORDS_PER_CASE } from "../config.mjs";
import { tierRecords } from "../src/dataset.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
function projectSql(name) {
  const p = join(ROOT, "database", name);
  if (!existsSync(p)) assert.fail(`${p} not found. Run the evaluation tests inside the full TRACE-X project (evaluation/ must sit next to database/).`);
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}
const schema = projectSql("01_schema.sql");
const access = projectSql("02_access.sql");
const routines = projectSql("03_routines.sql");

function procParams(name) {
  const m = routines.match(new RegExp(`CREATE PROCEDURE ${name}\\(([\\s\\S]*?)\\)\\s*SQL SECURITY`));
  assert.ok(m, `procedure ${name} not found`);
  return [...m[1].matchAll(/IN\s+(p_\w+)\s+([A-Z]+(?:\(\d+\))?(?:\s+UNSIGNED)?)/g)].map((x) => ({ name: x[1], type: x[2] }));
}
function tableColumns(table) {
  const m = schema.match(new RegExp(`CREATE TABLE \`?${table}\`? \\(([\\s\\S]*?)\\n\\) ENGINE`));
  assert.ok(m, `table ${table} not found`);
  return m[1].split("\n").map((l) => l.trim()).filter((l) => /^[a-z_0-9]+\s+[A-Z]/.test(l) && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)/.test(l))
    .map((l) => ({ name: l.split(/\s+/)[0], type: l.split(/\s+/)[1], required: /NOT NULL/.test(l) && !/DEFAULT|AUTO_INCREMENT/.test(l) }));
}

const ds = generateDataset();
const rec = ds.records[0];

test("sp_register_evidence: declared parameters match what the loader sends (12, in order, compatible types)", () => {
  const p = procParams("sp_register_evidence");
  assert.deepEqual(p.map((x) => x.name), ["p_case_id", "p_source_id", "p_type_id", "p_title", "p_description", "p_extracted_text", "p_sha256", "p_file_size", "p_collected_at", "p_method", "p_location", "p_notes"]);
  assert.deepEqual(p.map((x) => x.type), ["INT UNSIGNED", "INT UNSIGNED", "TINYINT UNSIGNED", "VARCHAR(200)", "TEXT", "MEDIUMTEXT", "VARCHAR(100)", "BIGINT UNSIGNED", "DATETIME", "VARCHAR(100)", "VARCHAR(150)", "TEXT"]);
  const a = registerArgs(7, 3, rec);
  assert.equal(a.length, p.length);
  assert.equal(a[1], null); // p_source_id: the procedure checks it only when not NULL
  assert.ok(a[3].length <= 200 && a[6].length <= 100 && a[9].length <= 100);
  assert.match(a[8], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.ok(new Date(a[8].replace(" ", "T") + "Z") < new Date(), "collected_at must not be in the future (procedure rejects it)");
  assert.ok(Number.isInteger(a[7]) && a[7] >= 0);
});

test("sp_create_case: 3 parameters; case numbers fit VARCHAR(30) and give distinct 3-character suffixes", () => {
  const p = procParams("sp_create_case");
  assert.deepEqual(p.map((x) => [x.name, x.type]), [["p_case_number", "VARCHAR(30)"], ["p_title", "VARCHAR(200)"], ["p_description", "TEXT"]]);
  for (const size of SIZES) {
    const nums = Array.from({ length: CASES }, (_, i) => caseArgs(size, i)[0]);
    assert.ok(nums.every((n) => n.length <= 30) && caseArgs(size, 0).length === 3);
    assert.equal(new Set(nums.map((n) => n.slice(-3))).size, CASES, "evidence_no uses RIGHT(case_number, 3); suffixes must differ");
    assert.equal(nums[0], evalCaseNumber(size, 0));
  }
  assert.ok(caseArgs(500, 0)[1].length <= 200);
});

test("evidence_no is built from RIGHT(case_number, 3) and a counter, as the loader assumes", () => {
  assert.match(routines, /CONCAT\('EV-', RIGHT\(v_case_number, 3\), '-', LPAD\(v_n, 2, '0'\)\)/);
});

test("the admin role may execute both procedures the loader calls", () => {
  for (const name of ["sp_create_case", "sp_register_evidence"]) {
    assert.match(access + routines, new RegExp(`GRANT EXECUTE ON PROCEDURE tracex\\.${name}\\s+TO [^;]*'tracex_admin'`), `${name}: no EXECUTE grant for tracex_admin`);
  }
});

test("record data fits the evidence columns and CHECK constraints", () => {
  const cols = Object.fromEntries(tableColumns("evidence").map((c) => [c.name, c.type]));
  assert.equal(cols.sha256, "CHAR(64)");
  assert.match(schema, /REGEXP_LIKE\(sha256, '\^\[0-9a-f\]\{64\}\$', 'c'\)/);
  for (const r of ds.records) {
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    assert.ok(r.title.length <= 200);
    assert.ok(Buffer.byteLength(r.description) <= 65535);
  }
  assert.match(schema, /CONSTRAINT uq_evidence_case_sha256 UNIQUE \(case_id, sha256\)/);
});

test("keyword SQL matches the real FULLTEXT index and column names", () => {
  assert.match(schema, /CREATE FULLTEXT INDEX ft_evidence_text ON evidence \(title, description, extracted_text\)/);
  assert.match(keywordSql(2, 10), /MATCH\(e\.title, e\.description, e\.extracted_text\)/);
  for (const col of ["evidence_id", "status", "case_id"]) assert.ok(tableColumns("evidence").some((c) => c.name === col), `evidence.${col} missing`);
  assert.match(schema, /status\s+ENUM\('active','withdrawn'\)/);
});

test("evaluation seed supplies every required column of role, evidence_type and app_user", () => {
  const seed = evalSeedSql("tracex_eval_500");
  assert.ok(tableColumns("role").filter((c) => c.required).every((c) => c.name === "role_id" || new RegExp(`INSERT INTO \`role\` \\(${c.name}\\)`).test(seed)));
  const et = tableColumns("evidence_type").filter((c) => c.required && c.name !== "type_id").map((c) => c.name);
  assert.deepEqual(et, ["name"]);
  assert.match(seed, /INSERT INTO evidence_type \(name, description\)/);
  const required = tableColumns("app_user").filter((c) => c.required).map((c) => c.name).sort();
  assert.deepEqual(required, ["email", "full_name", "password_hash", "role_id", "username"]);
  for (const c of required) assert.match(seed, new RegExp(`\\b${c}\\b`));
  // MySQL LIKE: % = any run, _ = exactly one character. Translate the real CHECK pattern from the schema.
  const like = schema.match(/CONSTRAINT ck_app_user_email\s+CHECK \(email LIKE '([^']+)'\)/)[1];
  const asRegex = new RegExp("^" + like.replace(/%/g, ".*").replace(/_/g, ".") + "$");
  assert.ok(asRegex.test("eval_admin@example.test"), `email must satisfy ck_app_user_email (LIKE '${like}')`);
  assert.ok(!asRegex.test("not-an-email"));
  assert.match(seed, new RegExp(`'${ADMIN_USERNAME}'`));
  for (const t of new Set(ds.records.map((r) => r.type))) assert.ok(EVIDENCE_TYPES.includes(t), `type ${t} is not seeded`);
  assert.match(seed, /role_name = 'Administrator'/);
});

test("each registration queues exactly one upsert job (trigger), so pending jobs == records", () => {
  assert.match(routines, /CREATE TRIGGER trg_evidence_ai AFTER INSERT ON evidence[\s\S]*?INSERT INTO index_job \(evidence_id, operation, content_version\)\s+VALUES \(NEW\.evidence_id, 'upsert', NEW\.content_version\)/);
  const reg = routines.match(/CREATE PROCEDURE sp_register_evidence[\s\S]*?\nEND\$\$/)[0];
  assert.equal((reg.match(/UPDATE\s+evidence/gi) || []).length, 0, "registration must not UPDATE evidence (would queue extra jobs)");
  assert.equal((reg.match(/INSERT INTO evidence\s*\(/g) || []).length, 1);
  assert.match(schema, /status\s+ENUM\('pending','processing','done','failed'\)/);
});

test("evidence_no counter is LPAD(n, 2): one case can hold at most 99 records, and no case in either tier exceeds that", () => {
  // LPAD truncates: LPAD('100', 2, '0') = '10', which collides with record 10 (found on a real MySQL 8).
  const width = Number(routines.match(/LPAD\(v_n, (\d+), '0'\)/)[1]);
  const maxPerCase = 10 ** width - 1;
  assert.equal(MAX_RECORDS_PER_CASE, maxPerCase, "config.MAX_RECORDS_PER_CASE must equal what the routine can number");
  for (const size of SIZES) {
    const per = {};
    for (const r of tierRecords(ds, size)) per[r.case_index] = (per[r.case_index] ?? 0) + 1;
    assert.equal(Object.keys(per).length, CASES);
    assert.ok(Math.max(...Object.values(per)) <= maxPerCase, `size ${size}: a case would exceed ${maxPerCase} records`);
  }
});
