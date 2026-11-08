// Reads database settings from environment variables.
// Nothing is read at import time: settings are read the first time a pool is
// needed, so `next build` works on a machine that has no .env file.
//
// Real values live only in app/.env.local (git-ignored). Never hard-code them.

import { DatabaseError } from "./errors.js";

// The three application roles. Each one has its own MySQL account and pool.
export const DB_ROLES = Object.freeze(["admin", "investigator", "worker"]);

const ENV_NAMES = Object.freeze({
  admin: { user: "DB_ADMIN_USER", password: "DB_ADMIN_PASSWORD" },
  investigator: {
    user: "DB_INVESTIGATOR_USER",
    password: "DB_INVESTIGATOR_PASSWORD",
  },
  worker: { user: "DB_WORKER_USER", password: "DB_WORKER_PASSWORD" },
});

const MAX_MYSQL_PORT = 65535;

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function readPositiveInt(env, name, fallback, max) {
  if (isBlank(env[name])) return fallback;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new DatabaseError(
      "DB_CONFIG",
      `Database configuration error: ${name} must be a whole number from 1 to ${max}.`,
      { status: 500 },
    );
  }
  return n;
}

// Returns the settings for one role's pool. Error messages name the missing
// variables but never print a value.
export function loadPoolConfig(role, env = process.env) {
  const names = ENV_NAMES[role];
  if (!names) {
    throw new DatabaseError("DB_CONFIG", `Unknown database role "${role}".`, {
      status: 500,
    });
  }

  const required = ["DB_HOST", "DB_PORT", "DB_NAME", names.user, names.password];
  const missing = required.filter((name) => isBlank(env[name]));
  if (missing.length > 0) {
    throw new DatabaseError(
      "DB_CONFIG",
      `Database configuration error: missing environment variable(s): ${missing.join(", ")}.`,
      { status: 500 },
    );
  }

  const user = String(env[names.user]);

  // If two roles shared one MySQL account, the database-level access control
  // would silently stop working. Refuse to start instead.
  for (const other of DB_ROLES) {
    if (other === role) continue;
    const otherUser = env[ENV_NAMES[other].user];
    if (!isBlank(otherUser) && String(otherUser) === user) {
      throw new DatabaseError(
        "DB_CONFIG",
        `Database configuration error: ${names.user} and ${ENV_NAMES[other].user} must be different MySQL accounts.`,
        { status: 500 },
      );
    }
  }

  return {
    host: String(env.DB_HOST),
    port: readPositiveInt(env, "DB_PORT", 3306, MAX_MYSQL_PORT),
    database: String(env.DB_NAME),
    user,
    password: String(env[names.password]),
    // Optional tuning. Defaults are fine for a course project.
    connectionLimit: readPositiveInt(env, "DB_POOL_LIMIT", 10, 100),
    connectTimeoutMs: readPositiveInt(env, "DB_CONNECT_TIMEOUT_MS", 10000, 120000),
    acquireTimeoutMs: readPositiveInt(env, "DB_ACQUIRE_TIMEOUT_MS", 10000, 120000),
  };
}
