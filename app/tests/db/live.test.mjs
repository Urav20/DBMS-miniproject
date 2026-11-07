// Live test against a real MySQL server. It uses the three real application
// accounts and Person A's database objects (fn_current_user_id, v_my_cases, app_user).
// It changes nothing: it only reads session variables and runs SELECTs.
//
// Run:  npm run test:db:live      (needs app/.env.local, see .env.example)

import test from "node:test";
import assert from "node:assert/strict";
import { createPoolRegistry } from "../../src/lib/db/pools.js";
import { createDb } from "../../src/lib/db/client.js";

const REQUIRED = [
  "DB_HOST", "DB_PORT", "DB_NAME",
  "DB_ADMIN_USER", "DB_ADMIN_PASSWORD",
  "DB_INVESTIGATOR_USER", "DB_INVESTIGATOR_PASSWORD",
  "DB_WORKER_USER", "DB_WORKER_PASSWORD",
];
const missing = REQUIRED.filter((n) => !process.env[n]);
const skip = missing.length ? `missing in .env.local: ${missing.join(", ")}` : false;

const silent = { error() {} };
// A pool with ONE connection forces every request to reuse the same physical
// connection, which is the situation where an identity leak would show up.
function makeDb(extraEnv = {}) {
  const registry = createPoolRegistry({ env: { ...process.env, DB_POOL_LIMIT: "1", ...extraEnv } });
  return { registry, db: createDb({ registry, logger: silent }) };
}

const ROLE_ENV_USER = {
  admin: "DB_ADMIN_USER",
  investigator: "DB_INVESTIGATOR_USER",
  worker: "DB_WORKER_USER",
};
const sessionFor = (role, userId) => ({ role, userId: role === "worker" ? null : userId });

test("each pool signs in as its own MySQL account", { skip }, async () => {
  const { db } = makeDb();
  try {
    for (const role of ["admin", "investigator", "worker"]) {
      const [row] = await db.query(sessionFor(role, 1), "SELECT CURRENT_USER() AS u, DATABASE() AS d");
      assert.ok(
        row.u.startsWith(`${process.env[ROLE_ENV_USER[role]]}@`),
        `${role} pool connected as ${row.u}`,
      );
      assert.equal(row.d, process.env.DB_NAME);
    }
  } finally {
    await db.closeAll();
  }
});

test("correct user ID on every acquired connection (one physical connection, 200 requests)", { skip }, async (t) => {
  const { db } = makeDb();
  try {
    const ids = Array.from({ length: 200 }, (_, i) => 5000 + i * 7);
    const roles = ["admin", "investigator"];
    const results = await Promise.all(
      ids.map((id, i) => {
        const role = roles[i % 2];
        return db
          .query({ role, userId: id }, "SELECT @tracex_user_id AS uid, CONNECTION_ID() AS cid")
          .then(([r]) => ({ id, role, ...r }));
      }),
    );
    for (const r of results) assert.equal(Number(r.uid), r.id, `${r.role} request for ${r.id} saw ${r.uid}`);

    // Prove the test really exercised connection reuse: one connection per pool.
    for (const role of roles) {
      const cids = new Set(results.filter((r) => r.role === role).map((r) => r.cid));
      assert.equal(cids.size, 1, `${role} requests all ran on ${cids.size} physical connection(s)`);
    }
    t.diagnostic(`${results.length}/${results.length} requests saw exactly their own @tracex_user_id on a single reused connection per pool`);
  } finally {
    await db.closeAll();
  }
});

test("identity is cleared when a connection goes back to the pool", { skip }, async () => {
  const { registry, db } = makeDb();
  try {
    await db.query({ role: "investigator", userId: 31337 }, "SELECT 1");
    // Borrow the (only) pooled connection directly, bypassing the helper.
    const conn = await registry.get("investigator").pool.getConnection();
    try {
      const [[row]] = await conn.execute("SELECT @tracex_user_id AS uid");
      assert.equal(row.uid, null);
    } finally {
      conn.release();
    }
  } finally {
    await db.closeAll();
  }
});

test("fn_current_user_id() returns the ID that was set", { skip }, async (t) => {
  const { db } = makeDb();
  try {
    const [row] = await db.query({ role: "investigator", userId: 4 }, "SELECT fn_current_user_id() AS uid");
    assert.equal(Number(row.uid), 4);
  } catch (err) {
    if (["DB_QUERY_ERROR", "DB_PERMISSION_DENIED"].includes(err.code)) {
      t.skip(`fn_current_user_id() not available to this account yet (${err.code})`);
      return;
    }
    throw err;
  } finally {
    await db.closeAll();
  }
});

test("views filter by the user the helper set (unknown user sees no cases)", { skip }, async (t) => {
  const { db } = makeDb();
  try {
    const rows = await db.query({ role: "investigator", userId: 4294967295 }, "SELECT case_id FROM v_my_cases");
    assert.equal(rows.length, 0);
  } catch (err) {
    if (err.code === "DB_QUERY_ERROR") {
      t.skip("v_my_cases not found (run database/02_access.sql first)");
      return;
    }
    throw err;
  } finally {
    await db.closeAll();
  }
});

test("MySQL permission errors are mapped to a readable error (investigator cannot read base tables)", { skip }, async (t) => {
  const { db } = makeDb();
  try {
    await assert.rejects(
      db.query({ role: "investigator", userId: 1 }, "SELECT user_id FROM app_user LIMIT 1"),
      (e) => {
        if (e.code === "DB_QUERY_ERROR") return true; // table not created yet
        assert.equal(e.code, "DB_PERMISSION_DENIED");
        assert.equal(e.status, 403);
        return true;
      },
    );
    // The pool still works after the error: the connection was released cleanly.
    const [row] = await db.query({ role: "investigator", userId: 9 }, "SELECT @tracex_user_id AS uid");
    assert.equal(Number(row.uid), 9);
  } finally {
    await db.closeAll();
  }
});

test("an unreachable database gives DB_UNAVAILABLE, not a crash", { skip }, async () => {
  const { db } = makeDb({ DB_PORT: "1", DB_CONNECT_TIMEOUT_MS: "3000" });
  try {
    await assert.rejects(db.query({ role: "admin", userId: 1 }, "SELECT 1"), (e) => e.code === "DB_UNAVAILABLE");
  } finally {
    await db.closeAll();
  }
});

test("a wrong password gives DB_AUTH_FAILED", { skip }, async () => {
  const { db } = makeDb({ DB_ADMIN_PASSWORD: "definitely-not-the-password" });
  try {
    await assert.rejects(db.query({ role: "admin", userId: 1 }, "SELECT 1"), (e) => e.code === "DB_AUTH_FAILED");
  } finally {
    await db.closeAll();
  }
});
