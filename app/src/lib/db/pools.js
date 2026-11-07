// Three separate MySQL connection pools, one per application role:
//   admin        -> DB_ADMIN_USER        (tracex_admin_app)
//   investigator -> DB_INVESTIGATOR_USER (tracex_investigator_app)
//   worker       -> DB_WORKER_USER       (tracex_worker_app)
//
// Each pool signs in with its own MySQL account, so MySQL itself enforces what
// that role may read or change. A pool is created the first time it is needed.

import mysql from "mysql2/promise";
import { DB_ROLES, loadPoolConfig } from "./config.js";
import { DatabaseError } from "./errors.js";

// `createPool` and `env` can be replaced in tests.
export function createPoolRegistry({
  createPool = mysql.createPool,
  env = process.env,
} = {}) {
  const pools = new Map();

  function get(role) {
    if (!DB_ROLES.includes(role)) {
      throw new DatabaseError("DB_CONFIG", `Unknown database role "${role}".`, {
        status: 500,
      });
    }
    const existing = pools.get(role);
    if (existing) return existing;

    const cfg = loadPoolConfig(role, env);
    const pool = createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: cfg.connectionLimit,
      queueLimit: 0,
      connectTimeout: cfg.connectTimeoutMs,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      // One statement per call: a second, injected statement cannot run.
      multipleStatements: false,
      namedPlaceholders: false,
      // BIGINT columns (audit_id, job_id) come back as numbers when safe, strings otherwise.
      supportBigNumbers: true,
      bigNumberStrings: false,
    });

    const entry = Object.freeze({ role, pool, acquireTimeoutMs: cfg.acquireTimeoutMs });
    pools.set(role, entry);
    return entry;
  }

  async function closeAll() {
    const entries = [...pools.values()];
    pools.clear();
    await Promise.allSettled(entries.map((e) => e.pool.end()));
  }

  return { get, closeAll };
}
