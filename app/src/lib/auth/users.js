// The one place that reads app_user for sign-in.
//
// Why the admin pool: the investigator account has no rights on base tables
// (02_access.sql), and TRACE-X_TEAM_CONTEXT.md section 10 says login reads app_user
// with the admin account. This file runs exactly one parameterized SELECT and returns
// one row to the server-side sign-in code. It never reaches the browser.
//
// The database helper requires a user ID on every request, and nobody is signed in
// yet. The largest possible INT UNSIGNED value is used to mean "no user yet". It is
// the same "unknown user" value tests/db/live.test.mjs already uses, and no real row
// can have it. (If you prefer, Person B can later add an explicit "pre-login" session
// type to src/lib/db/client.js instead.)

import { query } from "../db/index.js";

export const PRE_LOGIN_USER_ID = 4294967295;

// Table and column names come from TRACE-X_TEAM_CONTEXT.md section 7:
// app_user(user_id, role_id, username, full_name, password_hash, is_active, ...)
// role(role_id, role_name)
const FIND_LOGIN_USER_SQL =
  "SELECT u.user_id, u.username, u.full_name, u.password_hash, u.is_active, r.role_name " +
  "FROM app_user u JOIN `role` r ON r.role_id = u.role_id " +
  "WHERE u.username = ? LIMIT 1";

export async function findLoginUser(username, run = query) {
  const rows = await run(
    { role: "admin", userId: PRE_LOGIN_USER_ID },
    FIND_LOGIN_USER_SQL,
    [username],
  );
  return rows[0] ?? null;
}
