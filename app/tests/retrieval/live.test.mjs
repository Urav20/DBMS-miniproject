// Live checks for semantic retrieval against a REAL MySQL with Person A's schema loaded.
// SKIPPED (not passed) when the DB_* settings are missing.
//
//   cd app && npm run test:retrieval:live        (reads .env.local)
//
// These send only SELECTs for ids that cannot exist (4294967295), so nothing is read or changed.
// They prove, on the real database, what the unit tests can only assume:
//   - the investigator statements are valid and permitted for tracex_investigator_app
//   - the admin statements are valid and permitted for tracex_admin_app
//   - the admin account really has no access to v_my_* views (why the admin path uses base tables)
//   - the 'Administrator' role literal matches the seed data
//
// User ids: the demo seed numbers users in file order (1 = dana.whitfield, an Administrator;
// 3 = isha.kapoor, an Investigator). Override with TRACEX_LIVE_ADMIN_ID / TRACEX_LIVE_INVESTIGATOR_ID.
// This file has NOT been run by its author (no MySQL was available); a failure here names exactly
// what the real database does not provide.
//
// Qdrant and the embedding model are covered by tests/vector/live.test.mjs and are not repeated here.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as dbLayer from "../../src/lib/db/index.js";
import { createRetrievalRepository } from "../../src/lib/retrieval/repository.js";

const NEEDED = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_ADMIN_USER", "DB_ADMIN_PASSWORD", "DB_INVESTIGATOR_USER", "DB_INVESTIGATOR_PASSWORD"];
const absent = NEEDED.filter((k) => !process.env[k]);
const skip = absent.length ? `missing environment variable(s): ${absent.join(", ")}` : false;

const ADMIN = { role: "admin", userId: Number(process.env.TRACEX_LIVE_ADMIN_ID ?? 1) };
const INVESTIGATOR = { role: "investigator", userId: Number(process.env.TRACEX_LIVE_INVESTIGATOR_ID ?? 3) };
const NO_SUCH_ID = 4294967295;

const repo = createRetrievalRepository({ db: dbLayer });
after(async () => { await dbLayer.closeAll(); });

test("investigator: case scope and both re-validation statements run on the real views", { skip }, async () => {
  const scope = await repo.resolveCaseScope(INVESTIGATOR, null);
  assert.ok(Array.isArray(scope));
  const rows = await repo.loadAuthoritativeRows(INVESTIGATOR, {
    evidenceIds: [NO_SUCH_ID], findingIds: [NO_SUCH_ID], caseIds: scope.length ? scope : [NO_SUCH_ID],
  });
  assert.deepEqual(rows.evidence, []);
  assert.deepEqual(rows.findings, []);
  assert.equal(rows.accessPath, "investigator_views");
});

test("investigator: a case that does not exist is refused exactly like one the user cannot access", { skip }, async () => {
  await assert.rejects(() => repo.resolveCaseScope(INVESTIGATOR, [NO_SUCH_ID]), (e) => e.code === "CASE_ACCESS_DENIED" && e.status === 403);
});

test("investigator: no base-table access (the reason retrieval must use the views)", { skip }, async () => {
  await assert.rejects(() => dbLayer.query(INVESTIGATOR, "SELECT evidence_id FROM evidence WHERE 1 = 0"), (e) => e.code === "DB_PERMISSION_DENIED");
});

test("admin: case scope and both re-validation statements run on the base tables", { skip }, async () => {
  const scope = await repo.resolveCaseScope(ADMIN, null);
  assert.ok(Array.isArray(scope));
  const rows = await repo.loadAuthoritativeRows(ADMIN, {
    evidenceIds: [NO_SUCH_ID], findingIds: [NO_SUCH_ID], caseIds: scope.length ? scope : [NO_SUCH_ID],
  });
  assert.deepEqual(rows.evidence, []);
  assert.deepEqual(rows.findings, []);
  assert.equal(rows.accessPath, "admin_base_tables");
  assert.equal(rows.versionsAvailable, true);
});

test("admin account has NO grant on v_my_* views (documented mismatch with api-contract.md section 3)", { skip }, async () => {
  await assert.rejects(() => dbLayer.query(ADMIN, "SELECT evidence_id FROM v_my_evidence WHERE 1 = 0"), (e) => e.code === "DB_PERMISSION_DENIED");
});

test("an Investigator id presented on the admin pool is refused (role literal matches the real data)", { skip }, async () => {
  await assert.rejects(() => repo.resolveCaseScope({ role: "admin", userId: INVESTIGATOR.userId }, null), (e) => e.code === "AUTH_FORBIDDEN" && e.status === 403);
});

test("v_my_evidence does not expose content_version yet (Person A change 1): stale check unavailable to investigators", { skip, todo: "flips to passing after Person A change 1" }, async () => {
  await dbLayer.query(INVESTIGATOR, "SELECT content_version FROM v_my_evidence WHERE 1 = 0");
});
