// The per-request database helper.
//
// Every request follows exactly this path:
//   1. Validate the session { role, userId }      (nothing touches MySQL if invalid)
//   2. Pick the pool that matches the role
//   3. Acquire a connection
//   4. SET @tracex_user_id = ?                    (the authenticated user's ID)
//   5. Run parameterized SQL / CALL a stored procedure
//   6. SET @tracex_user_id = NULL, then release the connection
//      (if the reset fails, the connection is destroyed instead of reused)
//
// MySQL user variables belong to the connection, not to the request, and pooled
// connections are reused. Step 4 overwrites any earlier value and step 6 clears it,
// so one user's identity can never be seen by another user's request.

import { DB_ROLES } from "./config.js";
import {
  DatabaseError,
  isConnectionBroken,
  isExpectedRejection,
  toDatabaseError,
} from "./errors.js";

const SET_USER_SQL = "SET @tracex_user_id = ?";
const MAX_USER_ID = 4294967295; // INT UNSIGNED, same type as app_user.user_id
const PROCEDURE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// session = { role: "admin" | "investigator" | "worker", userId: number }
// The background worker has no signed-in person, so its userId may be null
// (the variable is then explicitly set to NULL). Admin and investigator
// sessions must carry a real user ID.
export function validateSession(session) {
  const invalid = (why) =>
    new DatabaseError("DB_INVALID_SESSION", `Invalid database session: ${why}.`, {
      status: 500,
    });

  if (!session || typeof session !== "object") throw invalid("session is missing");
  const { role, userId } = session;
  if (!DB_ROLES.includes(role)) throw invalid("unknown role");

  if (role === "worker" && userId === null) return { role, userId: null };

  if (
    typeof userId !== "number" ||
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    userId > MAX_USER_ID
  ) {
    throw invalid("userId must be a positive whole number");
  }
  return { role, userId };
}

// pool.getConnection() with a time limit. If the connection arrives after the
// limit, it is handed straight back so it is not lost.
function acquireConnection(pool, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(
        new DatabaseError(
          "DB_POOL_TIMEOUT",
          "The database is busy. Please try again.",
          { status: 503 },
        ),
      );
    }, timeoutMs);

    pool.getConnection().then(
      (conn) => {
        clearTimeout(timer);
        if (timedOut) conn.release();
        else resolve(conn);
      },
      (err) => {
        clearTimeout(timer);
        if (!timedOut) reject(err);
      },
    );
  });
}

export function createDb({ registry, logger = console } = {}) {
  if (!registry) throw new Error("createDb requires a pool registry.");

  function report(err, ctx) {
    if (err instanceof DatabaseError && !isExpectedRejection(err)) {
      // Never log SQL parameters or credentials, only codes and identifiers.
      logger.error("[tracex:db]", {
        ...ctx,
        code: err.code,
        errno: err.mysqlErrno,
        sqlState: err.sqlState,
        cause: err.cause?.message,
      });
    }
  }

  // Clears the identity, then returns the connection. A connection that cannot
  // be cleared is destroyed, never put back in the pool.
  async function finish(conn, broken) {
    let discard = broken;
    if (!discard) {
      try {
        await conn.execute(SET_USER_SQL, [null]);
      } catch {
        discard = true;
      }
    }
    try {
      if (discard) conn.destroy();
      else conn.release();
    } catch {
      /* nothing more can be done */
    }
  }

  // Runs `work(db)` on one connection that is tied to `session`.
  async function withSession(session, work) {
    const { role, userId } = validateSession(session);
    const ctx = { role, userId };
    const { pool, acquireTimeoutMs } = registry.get(role);

    let conn;
    try {
      conn = await acquireConnection(pool, acquireTimeoutMs);
    } catch (err) {
      const mapped = toDatabaseError(err);
      report(mapped, ctx);
      throw mapped;
    }

    let broken = false;
    let open = true;

    // `db` only works while `work` is running. If a forgotten (un-awaited) call
    // runs later, it fails instead of using a connection another user now owns.
    const guard = async (fn) => {
      if (!open) {
        throw new DatabaseError(
          "DB_SCOPE_CLOSED",
          "The database session has already ended.",
          { status: 500 },
        );
      }
      try {
        return await fn();
      } catch (err) {
        if (isConnectionBroken(err)) broken = true;
        throw toDatabaseError(err);
      }
    };

    const db = {
      // Parameterized statement. SELECT -> array of rows; INSERT/UPDATE/DELETE ->
      // result header (affectedRows, insertId). Values go in `params`, never in `sql`.
      query: (sql, params = []) =>
        guard(async () => {
          if (typeof sql !== "string") throw new TypeError("sql must be a string");
          if (!Array.isArray(params)) throw new TypeError("params must be an array");
          const [rows] = await conn.execute(sql, params);
          return rows;
        }),

      // CALL a stored procedure with parameters.
      // The name is checked against a strict pattern and quoted; it must come from
      // code, never from user input. Returns { resultSets, header } where
      // resultSets is an array with one array of rows per SELECT in the procedure.
      call: (name, params = []) =>
        guard(async () => {
          if (typeof name !== "string" || !PROCEDURE_NAME.test(name)) {
            throw new DatabaseError(
              "DB_BAD_QUERY",
              "Invalid stored procedure name.",
              { status: 500 },
            );
          }
          if (!Array.isArray(params)) throw new TypeError("params must be an array");
          const marks = params.map(() => "?").join(", ");
          const [rows] = await conn.execute(`CALL \`${name}\`(${marks})`, params);
          const parts = Array.isArray(rows) ? rows : [rows];
          return {
            resultSets: parts.filter(Array.isArray),
            header: parts.find((p) => !Array.isArray(p)),
          };
        }),
    };

    try {
      // Always the first statement on the connection, on every request.
      try {
        await conn.execute(SET_USER_SQL, [userId]);
      } catch (err) {
        if (isConnectionBroken(err)) broken = true;
        throw toDatabaseError(err);
      }
      return await work(db);
    } catch (err) {
      const mapped = toDatabaseError(err);
      report(mapped, ctx);
      throw mapped;
    } finally {
      open = false;
      await finish(conn, broken);
    }
  }

  return {
    withSession,

    // One parameterized statement as the given user.
    query: (session, sql, params = []) =>
      withSession(session, (db) => db.query(sql, params)),

    // One stored procedure call as the given user.
    callProcedure: (session, name, params = []) =>
      withSession(session, (db) => db.call(name, params)),

    closeAll: () => registry.closeAll(),
  };
}
