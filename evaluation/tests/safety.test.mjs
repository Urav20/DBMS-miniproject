import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import {
  assertEvalDb, assertEvalCollection, applyEvalEnv, evalDbName, evalCollectionName, assertConnectedToEvalDb, deleteEvalCollection, EvalSafetyError,
} from "../src/safety.mjs";
import { buildSetupSql, buildCleanupSql, verifyTransformed, renameDatabase } from "../src/sql-transform.mjs";

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database");
// These tests read Person A's real SQL. They never skip: without the full project they FAIL with this message.
for (const f of ["01_schema.sql", "02_access.sql", "03_routines.sql"]) {
  test(`project file present: database/${f}`, () => {
    assert.ok(existsSync(join(DB_DIR, f)), `database/${f} not found at ${DB_DIR}. Run the evaluation tests inside the full TRACE-X project (evaluation/ must sit next to database/).`);
  });
}

test("only names starting with tracex_eval are accepted", () => {
  for (const ok of ["tracex_eval", "tracex_eval_500", "tracex_eval_2000"]) {
    assert.equal(assertEvalDb(ok), ok);
    assert.equal(assertEvalCollection(ok), ok);
  }
  for (const bad of ["tracex", "tracex_records", "tracex_evaluation_x;", "TRACEX_EVAL_1", "xtracex_eval", "tracex_eval; DROP DATABASE tracex", "", null, undefined, 5]) {
    assert.throws(() => assertEvalDb(bad), EvalSafetyError);
    assert.throws(() => assertEvalCollection(bad), EvalSafetyError);
  }
});

test("target names derive only from the two allowed sizes", () => {
  assert.equal(evalDbName(500), "tracex_eval_500");
  assert.equal(evalCollectionName(2000), "tracex_eval_2000");
  assert.throws(() => evalDbName(1000), EvalSafetyError);
  assert.throws(() => evalCollectionName("tracex"), EvalSafetyError);
});

test("applyEvalEnv overwrites the development names in this process only", () => {
  const env = { DB_NAME: "tracex", QDRANT_COLLECTION: "tracex_records", DB_HOST: "h" };
  const t = applyEvalEnv(500, env);
  assert.deepEqual(t, { size: 500, dbName: "tracex_eval_500", collection: "tracex_eval_500" });
  assert.equal(env.DB_NAME, "tracex_eval_500");
  assert.equal(env.QDRANT_COLLECTION, "tracex_eval_500");
  assert.equal(env.DB_HOST, "h");
});

test("the connection is checked against what MySQL reports, not what we configured", async () => {
  const mk = (name) => ({ withSession: async (_s, fn) => fn({ query: async () => [{ db: name }] }) });
  assert.equal(await assertConnectedToEvalDb(mk("tracex_eval_500"), {}), "tracex_eval_500");
  await assert.rejects(() => assertConnectedToEvalDb(mk("tracex"), {}), EvalSafetyError);
  await assert.rejects(() => assertConnectedToEvalDb(mk(null), {}), EvalSafetyError);
});

test("collections are deleted only when the name is an evaluation collection", async () => {
  const deleted = [];
  const client = { collectionExists: async () => ({ exists: true }), deleteCollection: async (n) => deleted.push(n) };
  assert.equal(await deleteEvalCollection(client, "tracex_eval_500"), true);
  await assert.rejects(() => deleteEvalCollection(client, "tracex_records"), EvalSafetyError);
  await assert.rejects(() => deleteEvalCollection(client, "tracex"), EvalSafetyError);
  assert.deepEqual(deleted, ["tracex_eval_500"]);
});

test("generated setup SQL never mentions the development database", () => {
  const before = ["01_schema.sql", "02_access.sql", "03_routines.sql"].map((f) => readFileSync(join(DB_DIR, f), "utf8"));
  for (const size of [500, 2000]) {
    const db = `tracex_eval_${size}`;
    const sql = buildSetupSql({ databaseDir: DB_DIR, dbName: db });
    assert.ok(!/\btracex\b/.test(sql));
    assert.match(sql, new RegExp(`DROP DATABASE IF EXISTS ${db};`));
    assert.match(sql, new RegExp(`CREATE DATABASE ${db}`));
    assert.ok(sql.includes("'tracex_admin'"), "account and role names must be unchanged");
    assert.ok(sql.includes("@tracex_user_id"), "session variable must be unchanged");
    assert.match(sql, /INSERT INTO app_user/);
  }
  const after = ["01_schema.sql", "02_access.sql", "03_routines.sql"].map((f) => readFileSync(join(DB_DIR, f), "utf8"));
  assert.deepEqual(after, before); // Person A's files are only read
});

test("setup SQL for a non-evaluation database name is refused", () => {
  assert.throws(() => buildSetupSql({ databaseDir: DB_DIR, dbName: "tracex" }), EvalSafetyError);
  assert.throws(() => renameDatabase("USE tracex;", "tracex_records"), EvalSafetyError);
});

test("the SQL verifier fails closed on leaks", () => {
  const good = buildSetupSql({ databaseDir: DB_DIR, dbName: "tracex_eval_500" });
  assert.ok(verifyTransformed(good, "tracex_eval_500"));
  assert.throws(() => verifyTransformed(good + "\nUSE tracex;", "tracex_eval_500"), EvalSafetyError);
  assert.throws(() => verifyTransformed(good + "\nDROP DATABASE other;", "tracex_eval_500"), EvalSafetyError);
  assert.throws(() => verifyTransformed(good.replace("USE tracex_eval_500;", "USE other_db;"), "tracex_eval_500"), EvalSafetyError);
  assert.throws(() => verifyTransformed(good + "\nGRANT SELECT ON mysql.user TO 'x';", "tracex_eval_500"), EvalSafetyError);
  assert.throws(() => verifyTransformed(good + "\nSET GLOBAL read_only = 1;", "tracex_eval_500"), EvalSafetyError);
});

test("cleanup SQL drops only evaluation databases", () => {
  const sql = buildCleanupSql(["tracex_eval_500", "tracex_eval_2000"]);
  assert.deepEqual(sql.match(/DROP DATABASE IF EXISTS \w+;/g), ["DROP DATABASE IF EXISTS tracex_eval_500;", "DROP DATABASE IF EXISTS tracex_eval_2000;"]);
  assert.throws(() => buildCleanupSql(["tracex"]), EvalSafetyError);
});
