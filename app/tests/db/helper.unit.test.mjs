// Unit tests for the database helper. They use fake MySQL pools, so they need
// no database, no network and no .env file.
//
// Run:  npm run test:db

import test from "node:test";
import assert from "node:assert/strict";
import { createPoolRegistry } from "../../src/lib/db/pools.js";
import { createDb, validateSession } from "../../src/lib/db/client.js";
import { loadPoolConfig } from "../../src/lib/db/config.js";
import { DatabaseError, toDatabaseError } from "../../src/lib/db/errors.js";

const SET_SQL = "SET @tracex_user_id = ?";
const READ_SQL = "SELECT @tracex_user_id AS uid";

const TEST_ENV = {
  DB_HOST: "db.test",
  DB_PORT: "3306",
  DB_NAME: "tracex",
  DB_ADMIN_USER: "tracex_admin_app",
  DB_ADMIN_PASSWORD: "pw-admin-placeholder",
  DB_INVESTIGATOR_USER: "tracex_investigator_app",
  DB_INVESTIGATOR_PASSWORD: "pw-investigator-placeholder",
  DB_WORKER_USER: "tracex_worker_app",
  DB_WORKER_PASSWORD: "pw-worker-placeholder",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(Math.floor(Math.random() * 4));

// A fake pool that behaves like mysql2's: a fixed number of reusable connections,
// each with its own session variable that persists until changed.
function makeFakePool(options) {
  const conns = Array.from({ length: options.connectionLimit }, (_, i) => ({
    id: i,
    userVar: null, // the MySQL session variable @tracex_user_id
    inUse: false,
    destroyed: false,
    log: [],
    failNext: null, // { match: sql, error }
  }));
  const waiting = [];
  const pool = {
    options,
    conns,
    acquired: 0,
    released: 0,
    destroyed: 0,
    async getConnection() {
      await jitter();
      const free = conns.find((c) => !c.inUse && !c.destroyed);
      if (free) return hand(free);
      return new Promise((resolve) => waiting.push(resolve));
    },
    async end() {},
  };

  function hand(c) {
    c.inUse = true;
    pool.acquired += 1;
    return {
      raw: c,
      async execute(sql, params = []) {
        if (!c.inUse) throw new Error("FAKE: connection used after release");
        await jitter();
        c.log.push({ sql, params });
        if (c.failNext && c.failNext.match === sql) {
          const e = c.failNext.error;
          c.failNext = null;
          throw e;
        }
        if (sql === SET_SQL) {
          c.userVar = params[0];
          return [{ affectedRows: 0 }, undefined];
        }
        if (sql === READ_SQL) return [[{ uid: c.userVar }], undefined];
        if (sql.startsWith("CALL ")) {
          return [[[{ ok: 1 }], { affectedRows: 0, insertId: 0 }], undefined];
        }
        return [[{ echoed: params }], undefined];
      },
      release() {
        c.inUse = false;
        pool.released += 1;
        const next = waiting.shift();
        if (next) next(hand(c));
      },
      destroy() {
        c.inUse = false;
        c.destroyed = true;
        pool.destroyed += 1;
      },
    };
  }
  return pool;
}

function setup({ limit = 2, env = TEST_ENV, acquireTimeoutMs = 200 } = {}) {
  const pools = {};
  const registry = createPoolRegistry({
    env: { ...env, DB_POOL_LIMIT: String(limit), DB_ACQUIRE_TIMEOUT_MS: String(acquireTimeoutMs) },
    createPool: (options) => {
      pools[options.user] = makeFakePool(options);
      return pools[options.user];
    },
  });
  const silent = { error() {} };
  return { pools, registry, db: createDb({ registry, logger: silent }) };
}

// ---------------------------------------------------------------- pools

test("three separate pools, each using its own MySQL account", async () => {
  const { pools, db } = setup();
  assert.deepEqual(Object.keys(pools), [], "no pool is created before it is needed");

  await db.query({ role: "admin", userId: 1 }, "SELECT 1");
  await db.query({ role: "investigator", userId: 2 }, "SELECT 1");
  await db.query({ role: "worker", userId: null }, "SELECT 1");

  assert.deepEqual(Object.keys(pools).sort(), [
    "tracex_admin_app",
    "tracex_investigator_app",
    "tracex_worker_app",
  ]);
  assert.equal(pools.tracex_admin_app.options.password, "pw-admin-placeholder");
  assert.equal(pools.tracex_investigator_app.options.password, "pw-investigator-placeholder");
  assert.equal(pools.tracex_worker_app.options.password, "pw-worker-placeholder");
  assert.equal(pools.tracex_admin_app.options.multipleStatements, false);

  // A request for one role never touches another role's pool.
  assert.equal(pools.tracex_admin_app.acquired, 1);
  assert.equal(pools.tracex_investigator_app.acquired, 1);
  assert.equal(pools.tracex_worker_app.acquired, 1);
});

test("the same role reuses its pool", async () => {
  const { registry } = setup();
  assert.equal(registry.get("admin"), registry.get("admin"));
  assert.notEqual(registry.get("admin").pool, registry.get("investigator").pool);
});

// ------------------------------------------------- user ID on every connection

test("SET @tracex_user_id = ? is the first statement on every acquired connection", async () => {
  const { pools, db } = setup({ limit: 1 });
  await db.query({ role: "investigator", userId: 42 }, "SELECT 1 WHERE 1 = ?", [1]);

  const log = pools.tracex_investigator_app.conns[0].log;
  assert.deepEqual(log[0], { sql: SET_SQL, params: [42] });
  assert.equal(log[1].sql, "SELECT 1 WHERE 1 = ?");
  assert.deepEqual(log.at(-1), { sql: SET_SQL, params: [null] }, "cleared on release");
});

test("every request sees its own user ID: 90 concurrent requests, 3 roles, 2 connections per pool", async (t) => {
  const { pools, db } = setup({ limit: 2, acquireTimeoutMs: 5000 });
  const roles = ["admin", "investigator"];
  const jobs = [];
  for (let i = 0; i < 90; i += 1) {
    const session =
      i % 3 === 2
        ? { role: "worker", userId: null }
        : { role: roles[i % 3], userId: 1000 + i };
    jobs.push(
      db.query(session, READ_SQL).then((rows) => ({ expected: session.userId, seen: rows[0].uid })),
    );
  }
  const results = await Promise.all(jobs);

  for (const r of results) assert.equal(r.seen, r.expected);
  t.diagnostic(`${results.length}/${results.length} requests saw exactly their own @tracex_user_id`);

  // Connections were reused (only 2 per pool), and none keeps an identity afterwards.
  for (const pool of Object.values(pools)) {
    assert.equal(pool.conns.length, 2);
    assert.equal(pool.acquired, pool.released, "every acquired connection was released");
    for (const c of pool.conns) assert.equal(c.userVar, null, "no identity left on a pooled connection");
  }
});

test("back-to-back requests on one physical connection do not share identity", async () => {
  const { pools, db } = setup({ limit: 1 });
  const a = await db.query({ role: "investigator", userId: 11 }, READ_SQL);
  const between = pools.tracex_investigator_app.conns[0].userVar;
  const b = await db.query({ role: "investigator", userId: 22 }, READ_SQL);
  assert.equal(a[0].uid, 11);
  assert.equal(between, null, "identity is cleared when the connection goes back to the pool");
  assert.equal(b[0].uid, 22);
});

test("the worker session sets the variable to NULL explicitly", async () => {
  const { pools, db } = setup({ limit: 1 });
  await db.query({ role: "worker", userId: null }, "SELECT 1");
  assert.deepEqual(pools.tracex_worker_app.conns[0].log[0], { sql: SET_SQL, params: [null] });
});

// ------------------------------------------------------- session validation

test("invalid sessions are rejected before any connection is acquired", async () => {
  const { pools, db } = setup();
  const bad = [
    undefined, null, "admin", {},
    { role: "root", userId: 1 },
    { role: "admin" },
    { role: "admin", userId: null },
    { role: "investigator", userId: null },
    { role: "admin", userId: 0 },
    { role: "admin", userId: -3 },
    { role: "admin", userId: 1.5 },
    { role: "admin", userId: "5" },
    { role: "admin", userId: "1; DROP TABLE app_user" },
    { role: "admin", userId: NaN },
    { role: "admin", userId: 4294967296 },
  ];
  for (const session of bad) {
    await assert.rejects(db.query(session, "SELECT 1"), (e) => {
      assert.ok(e instanceof DatabaseError);
      assert.equal(e.code, "DB_INVALID_SESSION");
      return true;
    });
  }
  assert.deepEqual(Object.keys(pools), [], "no pool was even created");
  assert.throws(() => validateSession({ role: "worker", userId: 0 }));
});

// ----------------------------------------------------- safe release on errors

test("connection is released and cleared when the query fails", async () => {
  const { pools, db } = setup({ limit: 1 });
  await db.query({ role: "admin", userId: 1 }, "SELECT 1"); // creates the pool
  const conn = pools.tracex_admin_app.conns[0];
  conn.failNext = {
    match: "SELECT broken",
    error: Object.assign(new Error("x"), { errno: 1062, code: "ER_DUP_ENTRY", sqlState: "23000", sqlMessage: "Duplicate entry 'E-1' for key 'evidence_no'" }),
  };

  await assert.rejects(db.query({ role: "admin", userId: 9 }, "SELECT broken"), (e) => {
    assert.equal(e.code, "DB_DUPLICATE");
    assert.match(e.detail, /Duplicate entry/);
    return true;
  });
  assert.equal(conn.inUse, false);
  assert.equal(conn.userVar, null);
  assert.equal(pools.tracex_admin_app.acquired, pools.tracex_admin_app.released);
});

test("connection is released when SET @tracex_user_id itself fails", async () => {
  const { pools, db } = setup({ limit: 1 });
  await db.query({ role: "admin", userId: 1 }, "SELECT 1");
  const pool = pools.tracex_admin_app;
  pool.conns[0].failNext = { match: SET_SQL, error: Object.assign(new Error("gone"), { code: "ECONNRESET", fatal: true }) };

  await assert.rejects(db.query({ role: "admin", userId: 2 }, "SELECT 1"), (e) => e.code === "DB_UNAVAILABLE");
  assert.equal(pool.conns[0].inUse, false);
  assert.equal(pool.destroyed, 1, "a broken connection is destroyed, not returned to the pool");
});

test("a connection whose identity cannot be cleared is destroyed, never reused", async () => {
  const { pools, db } = setup({ limit: 1 });
  await db.query({ role: "admin", userId: 1 }, "SELECT 1");
  const pool = pools.tracex_admin_app;
  const conn = pool.conns[0];

  // Let the first SET succeed, fail the clearing SET at the end of the request.
  await db.withSession({ role: "admin", userId: 5 }, async (d) => {
    await d.query("SELECT 1");
    conn.failNext = { match: SET_SQL, error: new Error("reset failed") };
  });
  assert.equal(conn.destroyed, true);
  assert.equal(pool.destroyed, 1);
});

test("non-database errors thrown by the caller are rethrown unchanged and the connection is released", async () => {
  const { pools, db } = setup({ limit: 1 });
  const mine = new RangeError("programming mistake");
  await assert.rejects(
    db.withSession({ role: "admin", userId: 3 }, async () => { throw mine; }),
    (e) => e === mine,
  );
  const pool = pools.tracex_admin_app;
  assert.equal(pool.acquired, pool.released);
  assert.equal(pool.conns[0].userVar, null);
});

test("db handle stops working once the request has finished", async () => {
  const { db } = setup({ limit: 1 });
  let leaked;
  await db.withSession({ role: "admin", userId: 3 }, async (d) => { leaked = d; });
  await assert.rejects(leaked.query("SELECT 1"), (e) => e.code === "DB_SCOPE_CLOSED");
});

test("waiting too long for a free connection gives a readable error and loses no connection", async () => {
  const { pools, db } = setup({ limit: 1 });
  const hold = db.withSession({ role: "admin", userId: 1 }, async () => { await sleep(400); });
  await sleep(30);
  await assert.rejects(db.query({ role: "admin", userId: 2 }, "SELECT 1"), (e) => e.code === "DB_POOL_TIMEOUT");
  await hold;
  await sleep(50);
  const pool = pools.tracex_admin_app;
  assert.equal(pool.acquired, pool.released, "the late connection was handed back");
});

// ----------------------------------------------------------- SQL injection

test("hostile values travel only as parameters, never inside the SQL text", async () => {
  const { pools, db } = setup({ limit: 1 });
  const evil = "x'; DROP TABLE evidence; --";
  await db.query({ role: "investigator", userId: 7 }, "SELECT * FROM v_my_evidence WHERE title = ?", [evil]);

  const entry = pools.tracex_investigator_app.conns[0].log.find((l) => l.sql.includes("v_my_evidence"));
  assert.equal(entry.sql, "SELECT * FROM v_my_evidence WHERE title = ?");
  assert.deepEqual(entry.params, [evil]);
  assert.equal(pools.tracex_investigator_app.options.multipleStatements, false);
});

test("stored procedures: placeholders only, strict name check, result sets separated from the header", async () => {
  const { pools, db } = setup({ limit: 1 });
  const out = await db.callProcedure({ role: "admin", userId: 1 }, "sp_demo", [1, "a'b", null]);
  assert.deepEqual(out.resultSets, [[{ ok: 1 }]]);
  assert.equal(out.header.affectedRows, 0);

  const sent = pools.tracex_admin_app.conns[0].log.find((l) => l.sql.startsWith("CALL"));
  assert.equal(sent.sql, "CALL `sp_demo`(?, ?, ?)");
  assert.deepEqual(sent.params, [1, "a'b", null]);

  for (const name of ["sp_x(); DROP TABLE a", "sp x", "`sp_x`", "", "1abc", "a".repeat(65), 5, null]) {
    await assert.rejects(db.callProcedure({ role: "admin", userId: 1 }, name, []), (e) => e.code === "DB_BAD_QUERY");
  }
});

// ----------------------------------------------------------- error mapping

test("MySQL and network errors become readable, safe DatabaseErrors", () => {
  const mk = (extra) => Object.assign(new Error("raw"), extra);
  const cases = [
    [mk({ errno: 1644, sqlState: "45000", code: "ER_SIGNAL_EXCEPTION", sqlMessage: "Sender is not the current custodian" }), "DB_RULE_VIOLATION", 422, "Sender is not the current custodian"],
    [mk({ errno: 3819, sqlState: "HY000", code: "ER_CHECK_CONSTRAINT_VIOLATED", sqlMessage: "Check constraint 'chk' is violated." }), "DB_CONSTRAINT", 422, "Check constraint 'chk' is violated."],
    [mk({ errno: 1452, sqlState: "23000", code: "ER_NO_REFERENCED_ROW_2", sqlMessage: "fk fails" }), "DB_FOREIGN_KEY", 422, "fk fails"],
    [mk({ errno: 1142, sqlState: "42000", code: "ER_TABLEACCESS_DENIED_ERROR", sqlMessage: "SELECT command denied to user 'tracex_investigator_app'@'localhost' for table 'app_user'" }), "DB_PERMISSION_DENIED", 403, undefined],
    [mk({ errno: 1370, sqlState: "42000", code: "ER_PROCACCESS_DENIED_ERROR", sqlMessage: "execute denied" }), "DB_PERMISSION_DENIED", 403, undefined],
    [mk({ errno: 1045, sqlState: "28000", code: "ER_ACCESS_DENIED_ERROR", sqlMessage: "Access denied for user 'x'@'h' (using password: YES)" }), "DB_AUTH_FAILED", 503, undefined],
    [mk({ code: "ECONNREFUSED", errno: -111 }), "DB_UNAVAILABLE", 503, undefined],
    [mk({ code: "ETIMEDOUT" }), "DB_UNAVAILABLE", 503, undefined],
    [mk({ errno: 1064, sqlState: "42000", code: "ER_PARSE_ERROR", sqlMessage: "syntax near SELECT secret" }), "DB_QUERY_ERROR", 500, undefined],
  ];
  for (const [raw, code, status, detail] of cases) {
    const e = toDatabaseError(raw);
    assert.equal(e.code, code);
    assert.equal(e.status, status);
    assert.equal(e.detail, detail);
    assert.equal(e.cause, raw, "original error kept for server-side logging");
    // Nothing from the raw message (SQL text, user names, hosts) is in the safe message.
    assert.doesNotMatch(e.message, /tracex_|localhost|SELECT|password|secret/i);
  }
  const plain = new TypeError("not a db error");
  assert.equal(toDatabaseError(plain), plain);
});

// -------------------------------------------------------------- config

test("configuration errors name missing variables but never print secrets", () => {
  const env = { ...TEST_ENV };
  delete env.DB_INVESTIGATOR_PASSWORD;
  delete env.DB_HOST;
  assert.throws(
    () => loadPoolConfig("investigator", env),
    (e) => {
      assert.equal(e.code, "DB_CONFIG");
      assert.match(e.message, /DB_HOST/);
      assert.match(e.message, /DB_INVESTIGATOR_PASSWORD/);
      assert.doesNotMatch(e.message, /pw-/);
      return true;
    },
  );
  assert.throws(() => loadPoolConfig("admin", { ...TEST_ENV, DB_PORT: "abc" }), /DB_PORT/);
  assert.throws(() => loadPoolConfig("admin", { ...TEST_ENV, DB_ADMIN_PASSWORD: "  " }), /DB_ADMIN_PASSWORD/);
});

test("two roles may not share one MySQL account", () => {
  const env = { ...TEST_ENV, DB_INVESTIGATOR_USER: "tracex_admin_app" };
  assert.throws(() => loadPoolConfig("admin", env), /must be different MySQL accounts/);
  assert.throws(() => loadPoolConfig("investigator", env), /must be different MySQL accounts/);
});

test("a role whose settings are missing fails alone; other roles still work", async () => {
  const env = { ...TEST_ENV };
  delete env.DB_WORKER_PASSWORD;
  const { db } = setup({ env });
  await db.query({ role: "admin", userId: 1 }, "SELECT 1");
  await assert.rejects(db.query({ role: "worker", userId: null }, "SELECT 1"), (e) => e.code === "DB_CONFIG");
});
