// Public entry point for all database access in TRACE-X.
//
//   import { query, callProcedure, withSession } from "@/lib/db";
//
//   // One statement (investigator pool, user 7):
//   const cases = await query(
//     { role: "investigator", userId: 7 },
//     "SELECT case_id, title FROM v_my_cases WHERE status = ?",
//     ["open"],
//   );
//
//   // One stored procedure:
//   const { resultSets } = await callProcedure(session, "sp_some_procedure", [1, "x"]);
//
//   // Several statements on the same connection, same user:
//   await withSession(session, async (db) => {
//     const evidence = await db.query("SELECT evidence_id FROM v_my_evidence WHERE case_id = ?", [3]);
//     const custody = await db.query("SELECT * FROM v_my_custody WHERE evidence_id = ?", [evidence[0].evidence_id]);
//     return { evidence, custody };
//   });
//
// Server-side only (Route Handlers, Server Components, scripts). Never import this
// from a component that runs in the browser.

import { createDb } from "./client.js";
import { createPoolRegistry } from "./pools.js";

// Next.js dev mode reloads modules; keep one set of pools across reloads so
// connections are not leaked every time a file changes.
const globalKey = Symbol.for("tracex.db.instance");
const db = (globalThis[globalKey] ??= createDb({ registry: createPoolRegistry() }));

export const { withSession, query, callProcedure, closeAll } = db;
export { DatabaseError } from "./errors.js";
export { DB_ROLES } from "./config.js";
