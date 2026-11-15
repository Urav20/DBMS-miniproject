import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanText, isSameOrigin, mysqlDateTimeLocal, readJson, readPositiveId } from "../../src/lib/api/write-guards.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("write guards: same-origin writes reject a different Origin and allow same-origin requests", () => {
  const same = new Request("http://localhost:3000/api/workspace/cases", { headers: { origin: "http://localhost:3000", host: "localhost:3000" } });
  const different = new Request("http://localhost:3000/api/workspace/cases", { headers: { origin: "https://attacker.example", host: "localhost:3000" } });
  const noOrigin = new Request("http://localhost:3000/api/workspace/cases");
  assert.equal(isSameOrigin(same), true);
  assert.equal(isSameOrigin(different), false);
  assert.equal(isSameOrigin(noOrigin), true);
});

test("write guards: JSON parsing returns a tagged success or failure", async () => {
  const good = new Request("http://localhost", { method: "POST", body: JSON.stringify({ title: "ok" }) });
  const bad = new Request("http://localhost", { method: "POST", body: "{" });
  assert.deepEqual(await readJson(good), { ok: true, value: { title: "ok" } });
  assert.deepEqual(await readJson(bad), { ok: false, value: null });
});

test("write guards: route IDs must be positive unsigned INT strings", async () => {
  assert.equal(await readPositiveId({ params: Promise.resolve({ id: "42" }) }), 42);
  assert.equal(await readPositiveId({ params: { id: "4294967295" } }), 4294967295);
  for (const id of ["0", "-1", "1.5", "1x", "4294967296", "", null]) {
    assert.equal(await readPositiveId({ params: { id } }), null, `rejected ID ${String(id)}`);
  }
});

test("write guards: required and optional text limits are enforced", () => {
  assert.equal(cleanText("  title  ", 20, { required: true }), "title");
  assert.equal(cleanText(" ", 20, { required: true }), null);
  assert.equal(cleanText("12345", 4), null);
  assert.equal(cleanText(null, 10), null);
});

test("datetime-local validation preserves wall-clock time and rejects impossible dates", () => {
  assert.equal(mysqlDateTimeLocal("2026-11-15T11:24"), "2026-11-15 11:24:00");
  assert.equal(mysqlDateTimeLocal("2024-02-29T09:05:07"), "2024-02-29 09:05:07");
  assert.equal(mysqlDateTimeLocal("2024-02-30T09:05"), null);
  assert.equal(mysqlDateTimeLocal("not-a-date"), null);
  assert.equal(mysqlDateTimeLocal(null), null);
});

test("workflow API routes call the project's stored procedures, not direct evidence-table writes", () => {
  const routes = [
    ["app/src/app/api/workspace/cases/route.js", "sp_create_case"],
    ["app/src/app/api/workspace/cases/[id]/route.js", "sp_set_case_status"],
    ["app/src/app/api/workspace/cases/[id]/access/route.js", "sp_grant_access"],
    ["app/src/app/api/workspace/evidence/route.js", "sp_register_evidence"],
    ["app/src/app/api/workspace/evidence/[id]/custody/route.js", "sp_transfer_custody"],
    ["app/src/app/api/workspace/evidence/[id]/analysis/route.js", "sp_record_analysis"],
    ["app/src/app/api/workspace/analysis/[id]/complete/route.js", "sp_complete_analysis"],
    ["app/src/app/api/workspace/analysis/[id]/findings/route.js", "sp_add_finding"],
    ["app/src/app/api/workspace/relationships/route.js", "sp_link_evidence"],
  ];
  const routines = read("database/03_routines.sql");
  for (const [path, procedure] of routes) {
    const source = read(path);
    assert.ok(source.includes(`"${procedure}"`) || (procedure === "sp_grant_access" && source.includes("sp_revoke_access")), `${path} must call ${procedure}`);
    assert.ok(source.includes("authorizeRequest"), `${path} must authenticate and authorize the caller`);
    assert.ok(routines.includes(`CREATE PROCEDURE ${procedure}`), `${procedure} must exist in the SQL contract`);
  }
});

test("workspace repository uses filtered investigator views and the actual append-only audit timestamp", () => {
  const source = read("app/src/lib/workspace/repository.js");
  for (const view of ["v_my_cases", "v_my_evidence", "v_my_custody", "v_my_analyses", "v_my_findings", "v_my_relationships"]) {
    assert.ok(source.includes(view), `${view} is required for investigator reads`);
  }
  assert.match(source, /ORDER BY al\\.created_at DESC/);
  assert.doesNotMatch(source, /al\\.occurred_at/);
});
