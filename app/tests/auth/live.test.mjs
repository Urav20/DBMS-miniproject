// Live sign-in tests against a real MySQL server. They need Person A's tables
// (app_user, role) with at least one real user, created by the seed step.
// They only read: nothing is inserted, changed or deleted.
//
// Run:  npm run test:auth:live      (needs .env.local)
//
// Add to .env.local (never commit it). Use a real seeded account, not one made up here:
//   TEST_LOGIN_USERNAME=<an existing username>
//   TEST_LOGIN_PASSWORD=<that user's real password>
// Optional, to also test a deactivated account:
//   TEST_INACTIVE_USERNAME=<username of a user with is_active = 0>
//   TEST_INACTIVE_PASSWORD=<that user's password>
//
// Without these variables the tests are skipped, not passed.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { authenticate } from "../../src/lib/auth/service.js";
import { findLoginUser } from "../../src/lib/auth/users.js";
import { createSessionToken, verifySessionToken } from "../../src/lib/auth/session.js";
import { closeAll, query } from "../../src/lib/db/index.js";

const DB_VARS = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_ADMIN_USER", "DB_ADMIN_PASSWORD", "DB_INVESTIGATOR_USER", "DB_INVESTIGATOR_PASSWORD", "DB_WORKER_USER", "DB_WORKER_PASSWORD"];
const missingDb = DB_VARS.filter((n) => !process.env[n]);
const skipDb = missingDb.length ? `missing in .env.local: ${missingDb.join(", ")}` : false;
const skipLogin =
  skipDb || (!process.env.TEST_LOGIN_USERNAME || !process.env.TEST_LOGIN_PASSWORD
    ? "set TEST_LOGIN_USERNAME and TEST_LOGIN_PASSWORD in .env.local (a real seeded user)"
    : false);

const SECRET = randomBytes(32).toString("hex");
const find = (u) => findLoginUser(u);

test.after(async () => { await closeAll(); });

test("valid login against MySQL returns the user and a usable database session", { skip: skipLogin }, async () => {
  const user = await authenticate(
    { username: process.env.TEST_LOGIN_USERNAME, password: process.env.TEST_LOGIN_PASSWORD },
    { findUser: find },
  );
  assert.ok(["admin", "investigator"].includes(user.role), `role mapped to ${user.role}`);
  assert.ok(Number.isInteger(user.userId) && user.userId > 0);
  assert.equal(Object.hasOwn(user, "password_hash"), false);

  // The session round-trips and the database helper accepts it on the matching pool.
  const token = createSessionToken(user, { secret: SECRET });
  const session = verifySessionToken(token, { secret: SECRET });
  const [row] = await query({ role: session.role, userId: session.userId }, "SELECT @tracex_user_id AS uid");
  assert.equal(Number(row.uid), user.userId);
});

test("wrong password is rejected by the real database lookup", { skip: skipLogin }, async () => {
  await assert.rejects(
    authenticate({ username: process.env.TEST_LOGIN_USERNAME, password: `${process.env.TEST_LOGIN_PASSWORD}-wrong` }, { findUser: find }),
    (e) => e.code === "AUTH_INVALID_CREDENTIALS",
  );
});

test("unknown username is rejected the same way", { skip: skipDb }, async () => {
  await assert.rejects(
    authenticate({ username: `nobody-${randomBytes(6).toString("hex")}`, password: "whatever" }, { findUser: find }),
    (e) => e.code === "AUTH_INVALID_CREDENTIALS",
  );
});

test("SQL injection text in the username finds nobody", { skip: skipDb }, async () => {
  assert.equal(await find("x' OR '1'='1"), null);
  assert.equal(await find("' OR 1=1 -- "), null);
});

test("a deactivated user cannot sign in", { skip: skipDb || (!process.env.TEST_INACTIVE_USERNAME || !process.env.TEST_INACTIVE_PASSWORD ? "set TEST_INACTIVE_USERNAME and TEST_INACTIVE_PASSWORD" : false) }, async () => {
  await assert.rejects(
    authenticate({ username: process.env.TEST_INACTIVE_USERNAME, password: process.env.TEST_INACTIVE_PASSWORD }, { findUser: find }),
    (e) => e.code === "AUTH_INVALID_CREDENTIALS" && e.reason === "account deactivated",
  );
});
